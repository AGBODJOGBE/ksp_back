import { AppError, hasRole, requireUser } from '@ksp/platform';
import { type LegalActType, type NoticeDeliveryMethod, type PaidStage } from '../../domain/litigation';
import { type PartnerKind } from '../../domain/partner';
import { CaseErrors } from '../cases/case-errors';
import { type EvidenceActor } from '../cases/ports';
import { GATEWAY_CALLERS, requireCaller, ROLES } from '../shared/access';
import { type PartnerRef } from './escalation.port';
import { type LitigationCommit, type LitigationDeps, type PartnerRecord } from './litigation.ports';

/**
 * Règles communes du contentieux (lot R5) : rôles du manifeste de la gateway, accès du partenaire,
 * erreurs du contrat, libellés du journal de preuve et écriture d'une action.
 */

/** Courriers, escalade et partenaires (manifeste de la gateway : juriste et administrateurs). */
export const LEGAL_ROLES = [ROLES.legal, ROLES.admin, ROLES.superAdmin] as const;
/** Export du journal et lecture du référentiel des partenaires : juriste, administrateurs, superviseur. */
export const LEGAL_AND_SUPERVISORS = [ROLES.legal, ROLES.admin, ROLES.superAdmin, ROLES.supervisor] as const;
/** Accès partenaire : huissier ou avocat, sans double authentification (ADR-060, point 8). */
export const PARTNER_ROLES = [ROLES.bailiff, ROLES.lawyer] as const;

export const LitigationErrors = {
  partnerNotFound: () => AppError.notFound('RECOVERY_PARTNER_NOT_FOUND', 'Ce partenaire est introuvable.'),
  partnerNotActive: (status: string) =>
    AppError.precondition(
      'RECOVERY_PARTNER_NOT_ACTIVE',
      'Ce partenaire n’est pas actif : vérification en attente ou partenaire suspendu.',
      { status },
    ),
  /** Assignation inconnue, d'un autre partenaire ou terminée : jamais d'indice (R-AR-02). */
  assignmentNotFound: () =>
    AppError.notFound('RECOVERY_ASSIGNMENT_NOT_FOUND', 'Cette assignation est introuvable.'),
  noticeNotFound: () =>
    AppError.notFound('RECOVERY_CASE_NOT_FOUND', 'Cette mise en demeure est introuvable.'),
  approvalRequired: (message: string) =>
    AppError.precondition('RECOVERY_CREDITOR_APPROVAL_REQUIRED', message),
} as const;

/** Partenaire connecté (relayé par la gateway) : son compte, avec un rôle d'huissier ou d'avocat. */
export function requirePartnerUser(): { userId: string } {
  requireCaller(GATEWAY_CALLERS);
  const user = requireUser();
  if (!PARTNER_ROLES.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  return { userId: user.userId };
}

export const partnerActor = (userId: string): EvidenceActor => ({ type: 'partner', id: userId });

export function partnerRef(partner: PartnerRecord): PartnerRef {
  return { id: partner.id, kind: partner.kind, name: partner.name, office: partner.office };
}

export const PARTNER_KIND_LABELS: Record<PartnerKind, string> = {
  bailiff: 'huissier de justice',
  lawyer: 'avocat',
};

export const PAID_STAGE_LABELS: Record<PaidStage, string> = {
  bailiff: 'huissier',
  litigation: 'procédure judiciaire',
};

export const ACT_LABELS: Record<LegalActType, string> = {
  summons_to_pay: 'Sommation de payer',
  service: 'Signification',
  conservatory_measure: 'Mesure conservatoire',
  seizure: 'Saisie',
  injunction_request: 'Requête en injonction de payer',
  injunction_order: 'Ordonnance d’injonction de payer',
  hearing: 'Audience',
  judgment: 'Décision de justice',
  enforcement: 'Exécution forcée',
  insolvency_report: 'Constat d’insolvabilité ou de disparition',
  other: 'Autre acte',
};

export const DELIVERY_LABELS: Record<NoticeDeliveryMethod, string> = {
  hand_delivery: 'remise en main propre contre décharge',
  registered_mail: 'lettre recommandée',
  bailiff: 'huissier de justice',
  email: 'e-mail',
};

/** Texte d'une ligne (libellé, nom) : rogné, espaces réduits. */
export function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Écrit une action du contentieux. Le dossier, s'il est fourni, prend la date de sa dernière action ;
 * une écriture concurrente annule tout (le client recharge et réessaie).
 */
export async function commitLitigation(
  deps: Pick<LitigationDeps, 'litigation'>,
  commit: LitigationCommit,
): Promise<void> {
  let record = commit.record;
  if (record) {
    const last = commit.changes.evidence.reduce<Date | null>(
      (latest, entry) => (latest === null || entry.occurredAt > latest ? entry.occurredAt : latest),
      record.lastActionAt,
    );
    record = { ...record, lastActionAt: last };
  }
  const outcome = await deps.litigation.commit({ ...commit, ...(record ? { record } : {}) });
  if (outcome !== 'saved') throw CaseErrors.concurrentUpdate(commit.record?.status ?? 'active');
}
