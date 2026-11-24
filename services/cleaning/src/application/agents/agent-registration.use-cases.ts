import { type EmploymentKind } from '../../domain/planning/assignment-status';
import { type AgentDeps, type CleaningDeps } from '../deps';
import { type PlanningTx } from '../planning/planning.ports';
import { type OutboxMessage } from '../ports';
import { requireConnectedUser } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { replayed } from '../shared/idempotency';
import { idempotencyKey, requestHash, requireUuid, text } from '../shared/input';
import { agentErrors } from './agent-errors';
import { AgentAlreadyRegisteredError, type PlanningSettings } from './agent.ports';
import { agentProfile, type AgentProfile, cipherContext, parseWeekly } from './agent-views';

/**
 * Inscription d'un agent par lui-même (UC-NT-19, partie 9.1) et lecture de son profil. L'agent
 * devient « candidat » ; l'admin Nettoyage valide ses compétences une par une. Nom et prénom restent
 * dans identity : seul le nom d'affichage est recopié pour le planning.
 *
 * Inscription sur invitation (R-AG-02, piste A) : l'invitation présentée doit être en cours et avoir
 * été envoyée au numéro du compte qui s'inscrit ; elle est consommée dans la transaction de
 * l'inscription, et l'événement porte `source = invited`.
 */

export interface AgentApplicationInput {
  idempotencyKey: string;
  firstName: string;
  lastName: string;
  photoFileId: string;
  idDocumentFrontFileId: string;
  idDocumentBackFileId: string;
  residenceCommuneKey: string;
  zoneKeys: string[];
  skillCodes: string[];
  weekly: { weekday: string; ranges: { start: string; end: string }[] }[];
  emergencyContact?: { name: string; phone: string } | undefined;
  employmentKind: string;
  mobileMoneyNumber?: string | null;
  invitationId?: string | null;
}

const EMPLOYMENT_KINDS: readonly EmploymentKind[] = ['employee', 'independent'];

function required(value: string | undefined | null, field: string): string {
  const result = text(value, field);
  if (!result) throw cleaningErrors.invalid(field, 'required');
  return result;
}

function nonEmpty(values: readonly string[], field: string): string[] {
  const unique = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (!unique.length) throw cleaningErrors.invalid(field, 'required');
  return unique;
}

/** Champs de l'inscription, contrôlés (partie 9.1 : tout est obligatoire sauf le Mobile Money). */
export function parseApplication(input: AgentApplicationInput) {
  const firstName = required(input.firstName, 'firstName');
  const lastName = required(input.lastName, 'lastName');
  if (!EMPLOYMENT_KINDS.includes(input.employmentKind as EmploymentKind)) {
    throw cleaningErrors.invalid('employmentKind', input.employmentKind ? 'invalid_type' : 'required');
  }
  if (!input.emergencyContact) throw cleaningErrors.invalid('emergencyContact', 'required');
  const weekly = parseWeekly(input.weekly);
  if (!weekly.length) throw cleaningErrors.invalid('weekly', 'required');
  return {
    displayName: `${firstName} ${lastName}`,
    photoFileId: requireUuid(input.photoFileId, 'photoFileId'),
    idDocument: {
      frontFileId: requireUuid(input.idDocumentFrontFileId, 'idDocumentFrontFileId'),
      backFileId: requireUuid(input.idDocumentBackFileId, 'idDocumentBackFileId'),
    },
    homeCommuneKey: required(input.residenceCommuneKey, 'residenceCommuneKey'),
    zoneKeys: nonEmpty(input.zoneKeys, 'zoneKeys'),
    skillCodes: nonEmpty(input.skillCodes, 'skillCodes'),
    weekly,
    emergencyContact: {
      name: required(input.emergencyContact.name, 'emergencyContact.name'),
      phone: required(input.emergencyContact.phone, 'emergencyContact.phone'),
    },
    employmentKind: input.employmentKind as EmploymentKind,
    mobileMoneyNumber: text(input.mobileMoneyNumber, 'mobileMoneyNumber'),
  };
}

/** Compétences et zones connues et actives ; sinon CLEANING_SKILL_NOT_FOUND ou CLEANING_ZONE_NOT_FOUND. */
export async function requireCatalog(
  deps: CleaningDeps,
  skillCodes: readonly string[],
  zoneKeys: readonly string[],
): Promise<void> {
  const skills = await deps.planning.missingSkills(skillCodes);
  if (skills.length) throw cleaningErrors.skillNotFound(skills);
  const zones = await deps.planning.missingZones(zoneKeys);
  if (zones.length) throw cleaningErrors.zoneNotFound(zones);
}

export type AgentApplication = ReturnType<typeof parseApplication>;

/** Prénom et nom de la candidature, contrôlés comme dans parseApplication (créés chez identity). */
export function applicantName(input: Pick<AgentApplicationInput, 'firstName' | 'lastName'>): {
  firstName: string;
  lastName: string;
} {
  return {
    firstName: required(input.firstName, 'firstName'),
    lastName: required(input.lastName, 'lastName'),
  };
}

/**
 * Fichiers de la candidature (photo, pièce d'identité) rattachés chez file au nom de l'agent, avant
 * d'enregistrer leur référence (RV-102). `ownerId` : le compte qui les a envoyés, l'agent pour une
 * inscription, l'admin quand il crée l'agent.
 */
export async function attachApplicationFiles(
  deps: CleaningDeps,
  agentId: string,
  application: AgentApplication,
  ownerId: string,
): Promise<void> {
  for (const fileId of [
    application.photoFileId,
    application.idDocument.frontFileId,
    application.idDocument.backFileId,
  ]) {
    await deps.photos.attach({ fileId, subject: { type: 'cleaning_agent', id: agentId }, ownerId });
  }
}

/**
 * Agent écrit dans la transaction, pour une inscription comme pour une création par l'admin : fiche
 * (données personnelles chiffrées), compétences déclarées, zones et plages hebdomadaires. Rend
 * l'événement cleaning.agent.applied, que l'appelant publie avec ses traces.
 */
export async function insertAgentFromApplication(
  deps: CleaningDeps,
  tx: PlanningTx,
  settings: PlanningSettings,
  input: {
    agentId: string;
    userId: string;
    status: 'applicant' | 'under_review';
    /** Admin qui crée l'agent ; null pour une inscription. */
    createdBy: string | null;
    source: 'self' | 'admin_created' | 'invited';
    application: AgentApplication;
    /** Auteur des plages hebdomadaires : l'agent, ou l'admin. */
    by: string;
    now: Date;
  },
): Promise<OutboxMessage> {
  const { agentId, application, now } = input;
  const { cipher } = deps;
  await tx.insertAgent({
    id: agentId,
    userId: input.userId,
    status: input.status,
    employmentKind: application.employmentKind,
    displayName: application.displayName,
    photoFileId: application.photoFileId,
    homeCommuneKey: application.homeCommuneKey,
    idDocumentEncrypted: cipher.encrypt(
      JSON.stringify(application.idDocument),
      cipherContext.idDocument(agentId),
    ),
    emergencyContactEncrypted: cipher.encrypt(
      JSON.stringify(application.emergencyContact),
      cipherContext.emergencyContact(agentId),
    ),
    mobileMoneyEncrypted: application.mobileMoneyNumber
      ? cipher.encrypt(application.mobileMoneyNumber, cipherContext.mobileMoney(agentId))
      : null,
    maxHoursDay: settings.defaultMaxHoursDay,
    maxHoursWeek: settings.defaultMaxHoursWeek,
    createdBy: input.createdBy,
    createdAt: now,
  });
  await tx.replaceSkills(
    agentId,
    application.skillCodes.map((code) => ({ code, status: 'declared' as const })),
    null,
    now,
  );
  await tx.replaceZones(agentId, application.zoneKeys);
  await tx.replaceWeekly(agentId, application.weekly, input.by, now);
  return {
    type: 'cleaning.agent.applied',
    payload: {
      agentId,
      userId: input.userId,
      source: input.source,
      appliedAt: now.toISOString(),
      zoneKeys: application.zoneKeys,
    },
  };
}

/**
 * Invitation présentée à l'inscription : connue, ni consommée ni expirée, et envoyée au numéro du
 * compte qui s'inscrit (identity rend le compte du numéro invité ; le numéro ne sort pas du service).
 */
export async function requireUsableInvitation(
  deps: AgentDeps,
  invitationId: string,
  userId: string,
  now: Date,
): Promise<void> {
  const invitation = await deps.planning.invitationById(invitationId);
  if (!invitation) throw agentErrors.invitationRefused('invitation_not_found');
  if (invitation.consumedAt || !invitation.phoneEncrypted) {
    throw agentErrors.invitationRefused('invitation_consumed');
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    throw agentErrors.invitationRefused('invitation_expired');
  }
  const phone = deps.cipher.decrypt(invitation.phoneEncrypted, cipherContext.invitationPhone(invitation.id));
  const account = await deps.accounts.findByPhone(phone);
  if (account?.userId !== userId) throw agentErrors.invitationRefused('invitation_not_found');
}

export class SubmitAgentApplicationUseCase {
  constructor(private readonly deps: AgentDeps) {}

  async execute(input: AgentApplicationInput): Promise<AgentProfile> {
    const userId = requireConnectedUser();
    const key = idempotencyKey(input.idempotencyKey);
    const application = parseApplication(input);
    const invitationId = input.invitationId?.trim() ? requireUuid(input.invitationId, 'invitationId') : null;
    // Sans invitation, l'empreinte reste celle de la candidature seule.
    const hash = invitationId ? requestHash({ application, invitationId }) : requestHash(application);
    const ref = { actorId: userId, operation: 'agent.apply', key };
    const replay = await replayed<{ agentId: string }>(this.deps.planning, ref, hash);
    if (replay) return this.profile(replay.agentId);

    await requireCatalog(this.deps, application.skillCodes, application.zoneKeys);
    if (await this.deps.planning.agentByUserId(userId)) throw cleaningErrors.alreadyRegistered();
    const now = this.deps.clock.now();
    if (invitationId) await requireUsableInvitation(this.deps, invitationId, userId, now);
    const agentId = this.deps.ids.next();
    await attachApplicationFiles(this.deps, agentId, application, userId);
    const settings = await this.deps.planning.settings();
    try {
      await this.deps.planning.transaction(async (tx) => {
        // Consommée avant toute écriture : une invitation utilisée entre-temps arrête l'inscription.
        if (invitationId && !(await tx.consumeInvitation(invitationId, agentId, now))) {
          throw agentErrors.invitationRefused('invitation_consumed');
        }
        const applied = await insertAgentFromApplication(this.deps, tx, settings, {
          agentId,
          userId,
          status: 'applicant',
          createdBy: null,
          source: invitationId ? 'invited' : 'self',
          application,
          by: userId,
          now,
        });
        await tx.write({ events: [applied], audit: [] });
        await tx.remember({ ...ref, requestHash: hash, response: { agentId } });
      });
    } catch (error) {
      if (error instanceof AgentAlreadyRegisteredError) throw cleaningErrors.alreadyRegistered();
      throw error;
    }
    return this.profile(agentId);
  }

  private async profile(agentId: string): Promise<AgentProfile> {
    const agent = await this.deps.planning.agentById(agentId);
    if (!agent) throw cleaningErrors.agentNotFound();
    return agentProfile(this.deps, agent);
  }
}

/** Mon profil d'agent : suivi de la candidature, compétences validées, zones. */
export class GetMyAgentProfileUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(): Promise<AgentProfile> {
    const userId = requireConnectedUser();
    const agent = await this.deps.planning.agentByUserId(userId);
    if (!agent) throw cleaningErrors.agentNotFound();
    return agentProfile(this.deps, agent);
  }
}
