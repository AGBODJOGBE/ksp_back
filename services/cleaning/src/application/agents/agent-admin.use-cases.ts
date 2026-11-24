import {
  type AgentSkillStatus,
  AGENT_STATUSES,
  type AgentStatus,
  checkDeactivation,
  suspensionRelease,
  transitionAgent,
} from '../../domain/agents/agent';
import { type EmploymentKind } from '../../domain/planning/assignment-status';
import { planningError } from '../../domain/planning/errors';
import { type AgentDeps, type CleaningDeps } from '../deps';
import { type AuditEntry, type OutboxMessage } from '../ports';
import { assignmentsByIds, audit, releaseAssignments } from '../planning/assignment-support';
import { type PlanningTx } from '../planning/planning.ports';
import { requireStaff } from '../shared/access';
import { cleaningErrors, planningAppError, refusal } from '../shared/errors';
import { replayed, writeError } from '../shared/idempotency';
import {
  hoursLimit,
  idempotencyKey,
  isOffsetCursor,
  page,
  type Page,
  requestHash,
  requiredReason,
  text,
} from '../shared/input';
import { type AgentFilter, type AgentRecord, type AgentSort } from './agent.ports';
import { requireCatalog } from './agent-registration.use-cases';
import { agentProfile, type AgentProfile, agentProfiles, cipherContext } from './agent-views';

/**
 * Agents au back-office (UC-NT-34, UC-NT-35) : liste, fiche, modification, et cycle de vie
 * (vérification, validation, refus, suspension, réactivation, désactivation). Chaque changement de
 * statut est tracé (agent.status_changed) ; le motif saisi reste sur la fiche (status_reason), jamais
 * dans le journal (texte libre).
 */

/** Agent du back-office, ou CLEANING_AGENT_NOT_FOUND. */
async function requireAgent(reader: { agentById(id: string): Promise<AgentRecord | null> }, id: string) {
  const agent = await reader.agentById(id);
  if (!agent) throw cleaningErrors.agentNotFound();
  return agent;
}

const SORTS: readonly AgentSort[] = ['lastName', '-createdAt', '-ratingAverage'];

export class ListAgentsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    status?: string | null;
    zoneKey?: string | null;
    skillCode?: string | null;
    q?: string | null;
    limit?: number;
    cursor?: string;
    sort?: string | null;
  }): Promise<Page<AgentProfile>> {
    requireStaff();
    if (input.status && !AGENT_STATUSES.includes(input.status as AgentStatus)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    if (input.sort && !SORTS.includes(input.sort as AgentSort))
      throw cleaningErrors.invalid('sort', 'invalid_type');
    const filter: AgentFilter = {
      status: (input.status as AgentStatus) || null,
      zoneKey: input.zoneKey || null,
      skillCode: input.skillCode || null,
      q: text(input.q, 'q'),
      sort: (input.sort as AgentSort) || 'lastName',
    };
    // Curseur opaque : décalage dans la liste triée.
    const result = await this.deps.planning.listAgents(
      filter,
      page(input.limit, input.cursor, isOffsetCursor),
    );
    return { ...result, items: await agentProfiles(this.deps, result.items, false) };
  }
}

export class GetAgentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(agentId: string): Promise<AgentProfile> {
    requireStaff();
    return agentProfile(this.deps, await requireAgent(this.deps.planning, agentId));
  }
}

const EMPLOYMENT_KINDS: readonly EmploymentKind[] = ['employee', 'independent'];

/** Compétences après validation : les codes cités sont validés, une validée non citée redevient déclarée. */
function validatedSkills(
  current: AgentRecord['skills'],
  codes: readonly string[],
  replace: boolean,
): { code: string; status: AgentSkillStatus }[] {
  const kept = current.map((skill) => ({
    code: skill.code,
    status: codes.includes(skill.code)
      ? ('validated' as const)
      : replace && skill.status === 'validated'
        ? ('declared' as const)
        : skill.status,
  }));
  const added = codes
    .filter((code) => !current.some((s) => s.code === code))
    .map((code) => ({ code, status: 'validated' as const }));
  return [...kept, ...added];
}

/**
 * Modifier un agent (champs absents inchangés). Retirer une compétence validée ou une zone ne
 * désaffecte rien (contrat) : ses affectations à venir restent, au superviseur de les revoir.
 */
export class UpdateAgentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    agentId: string;
    zoneKeys?: string[] | null;
    validatedSkillCodes?: string[] | null;
    maxHoursPerDay?: number | null;
    maxHoursPerWeek?: number | null;
    employmentKind?: string | null;
    residenceCommuneKey?: string | null;
    emergencyContact?: { name: string; phone: string } | null;
  }): Promise<AgentProfile> {
    const actorId = requireStaff();
    const maxHoursDay = hoursLimit(input.maxHoursPerDay, 'maxHoursPerDay', 24);
    const maxHoursWeek = hoursLimit(input.maxHoursPerWeek, 'maxHoursPerWeek', 168);
    if (input.employmentKind && !EMPLOYMENT_KINDS.includes(input.employmentKind as EmploymentKind)) {
      throw cleaningErrors.invalid('employmentKind', 'invalid_type');
    }
    const zoneKeys = input.zoneKeys ? [...new Set(input.zoneKeys)] : null;
    const skillCodes = input.validatedSkillCodes ? [...new Set(input.validatedSkillCodes)] : null;
    await requireCatalog(this.deps, skillCodes ?? [], zoneKeys ?? []);
    const existing = await requireAgent(this.deps.planning, input.agentId);
    const now = this.deps.clock.now();
    try {
      await this.deps.planning.transaction(async (tx) => {
        await tx.lockAgents([existing.id]);
        const agent = await requireAgent(tx, existing.id);
        const day = maxHoursDay ?? agent.maxHoursDay;
        if (day > (maxHoursWeek ?? agent.maxHoursWeek))
          throw cleaningErrors.invalid('maxHoursPerDay', 'out_of_range');
        const contact =
          input.emergencyContact?.name?.trim() && input.emergencyContact.phone?.trim()
            ? input.emergencyContact
            : null;
        await tx.updateAgent(agent.id, agent.version, {
          ...(maxHoursDay !== undefined ? { maxHoursDay } : {}),
          ...(maxHoursWeek !== undefined ? { maxHoursWeek } : {}),
          ...(input.employmentKind ? { employmentKind: input.employmentKind as EmploymentKind } : {}),
          ...(input.residenceCommuneKey?.trim() ? { homeCommuneKey: input.residenceCommuneKey.trim() } : {}),
          ...(contact
            ? {
                emergencyContactEncrypted: this.deps.cipher.encrypt(
                  JSON.stringify({ name: contact.name.trim(), phone: contact.phone.trim() }),
                  cipherContext.emergencyContact(agent.id),
                ),
              }
            : {}),
          updatedAt: now,
        });
        const trail: AuditEntry[] = [];
        if (zoneKeys) {
          await tx.replaceZones(agent.id, zoneKeys);
          trail.push(
            audit(actorId, 'agent.zones_changed', 'agent', agent.id, now, {
              before: agent.zoneKeys,
              after: zoneKeys,
            }),
          );
        }
        if (skillCodes) {
          await tx.replaceSkills(agent.id, validatedSkills(agent.skills, skillCodes, true), actorId, now);
          trail.push(audit(actorId, 'agent.skills_validated', 'agent', agent.id, now, { skillCodes }));
        }
        await tx.write({ events: [], audit: trail });
      });
    } catch (error) {
      throw writeError(error);
    }
    return agentProfile(this.deps, await requireAgent(this.deps.planning, existing.id));
  }
}

export type AgentAction = 'review' | 'approve' | 'reject' | 'suspend' | 'reactivate' | 'deactivate';

/** Statut d'arrivée et statut de départ exigé par l'action, quand la transition seule ne suffit pas. */
const ACTIONS: Readonly<Record<AgentAction, { to: AgentStatus; from?: AgentStatus; reason: boolean }>> = {
  review: { to: 'under_review', reason: false },
  approve: { to: 'active', from: 'under_review', reason: false },
  reject: { to: 'rejected', reason: true },
  suspend: { to: 'suspended', reason: true },
  reactivate: { to: 'active', from: 'suspended', reason: false },
  deactivate: { to: 'deactivated', reason: true },
};

/** Motifs système enregistrés sur les affectations retirées (R-PL-09). */
const RELEASE_REASONS = { suspend: 'agent_suspended', deactivate: 'agent_deactivated' } as const;

/** Motifs tracés par identity dans son journal d'audit, avec cleaning pour auteur (R-AG-01). */
const ROLE_REASONS = {
  approve: 'Agent validé',
  reactivate: 'Agent réactivé',
  deactivate: 'Agent désactivé',
  unused: 'Validation non enregistrée',
} as const;

/** Transition refusée d'après le statut de départ exigé par l'action. */
function requireStart(action: AgentAction, status: AgentStatus): void {
  const { to, from } = ACTIONS[action];
  if (from && status !== from) {
    throw planningAppError(planningError('CLEANING_INVALID_TRANSITION', { from: status, to }));
  }
}

/**
 * Changement de statut d'un agent (partie 9.1, transitions de 15.2).
 *
 * Rôle cleaning_agent (R-AG-01, ADR-057 décision 8) : jamais d'agent actif sans rôle. identity et
 * cleaning n'écrivent pas dans la même transaction ; l'ordre des deux écritures fait qu'un échec
 * laisse toujours un état sans danger et rejouable :
 * - validation et réactivation : le rôle est attribué (GrantRole, idempotent) AVANT que l'agent ne
 *   devienne actif. identity injoignable ou qui refuse : l'action échoue, rien n'est écrit. Écriture
 *   locale en échec après l'attribution : il reste un rôle sans agent actif, sans effet (le service
 *   contrôle le statut de l'agent à chaque appel) ; rejouer l'action retrouve la même attribution ;
 * - désactivation : le statut est écrit AVANT le retrait du rôle (RevokeRole, idempotent).
 *   L'attribution reste notée sur la fiche tant que le rôle n'est pas retiré : si identity est
 *   injoignable, l'action échoue (indisponibilité) alors que l'agent est déjà désactivé, et la
 *   rejouer avec la même clé reprend le retrait. L'ordre inverse laisserait, sur un échec de
 *   l'écriture locale, un agent actif sans rôle ;
 * - suspension : le rôle est gardé (un agent suspendu n'est plus affecté et ne peut plus agir).
 */
export class ChangeAgentStatusUseCase {
  constructor(private readonly deps: AgentDeps) {}

  async execute(input: {
    action: AgentAction;
    agentId: string;
    idempotencyKey: string;
    reason?: string | null;
    reassign?: boolean;
    validatedSkillCodes?: string[];
  }): Promise<AgentProfile> {
    const actorId = requireStaff();
    const key = idempotencyKey(input.idempotencyKey);
    const action = ACTIONS[input.action];
    const reason = action.reason ? requiredReason(input.reason) : null;
    const skillCodes = [...new Set(input.validatedSkillCodes ?? [])];
    const hash = requestHash({
      agentId: input.agentId,
      reason,
      reassign: input.reassign ?? false,
      skillCodes,
    });
    const ref = { actorId, operation: `agent.${input.action}`, key };
    if (!(await replayed(this.deps.planning, ref, hash))) {
      if (input.action === 'approve') await requireCatalog(this.deps, skillCodes, []);
      const existing = await requireAgent(this.deps.planning, input.agentId);
      // Refusée d'après une première lecture, avant tout appel à identity ; relue sous verrou ensuite.
      requireStart(input.action, existing.status);
      const role =
        input.action === 'approve' || input.action === 'reactivate'
          ? await this.deps.roles.grant({ userId: existing.userId, reason: ROLE_REASONS[input.action] })
          : null;
      const now = this.deps.clock.now();
      try {
        await this.deps.planning.transaction(async (tx) => {
          await tx.lockAgents([existing.id]);
          const agent = await requireAgent(tx, existing.id);
          const changes = await this.apply(tx, agent, input, reason, actorId, now, role?.assignmentId);
          await tx.write(changes);
          await tx.remember({ ...ref, requestHash: hash, response: { agentId: agent.id } });
        });
      } catch (error) {
        if (role) await this.dropUnusedRole(existing.id, role.assignmentId);
        throw writeError(error);
      }
    }
    const agent = await this.withoutPendingRole(await requireAgent(this.deps.planning, input.agentId));
    return agentProfile(this.deps, agent);
  }

  /**
   * Agent désactivé dont l'attribution est encore notée : le rôle est retiré chez identity, puis
   * l'attribution effacée de la fiche. Fait après chaque action, rejeu compris : un retrait resté en
   * attente (identity injoignable) reprend quand l'admin rejoue la désactivation.
   */
  private async withoutPendingRole(agent: AgentRecord): Promise<AgentRecord> {
    const assignmentId = agent.roleAssignmentId;
    if (agent.status !== 'deactivated' || !assignmentId) return agent;
    await this.deps.roles.revoke({ assignmentId, reason: ROLE_REASONS.deactivate });
    const now = this.deps.clock.now();
    try {
      await this.deps.planning.transaction(async (tx) => {
        await tx.lockAgents([agent.id]);
        const current = await requireAgent(tx, agent.id);
        if (current.roleAssignmentId !== assignmentId) return;
        await tx.updateAgent(current.id, current.version, { roleAssignmentId: null, updatedAt: now });
      });
    } catch (error) {
      throw writeError(error);
    }
    return requireAgent(this.deps.planning, agent.id);
  }

  /**
   * L'écriture a échoué après l'attribution du rôle (agent modifié entre-temps par un autre appel) :
   * le rôle est retiré s'il n'appartient ni à un agent actif ni à la fiche de l'agent. Au mieux : un
   * échec ici laisse un rôle sans agent actif, sans effet, que le rejeu de l'action retrouve.
   */
  private async dropUnusedRole(agentId: string, assignmentId: string): Promise<void> {
    try {
      const agent = await this.deps.planning.agentById(agentId);
      if (!agent || agent.status === 'active' || agent.roleAssignmentId === assignmentId) return;
      await this.deps.roles.revoke({ assignmentId, reason: ROLE_REASONS.unused });
    } catch {
      // L'erreur rendue à l'appelant reste celle de l'écriture.
    }
  }

  private async apply(
    tx: PlanningTx,
    agent: AgentRecord,
    input: { action: AgentAction; reassign?: boolean; validatedSkillCodes?: string[] },
    reason: string | null,
    actorId: string,
    now: Date,
    roleAssignmentId: string | undefined,
  ): Promise<{ events: OutboxMessage[]; audit: AuditEntry[] }> {
    const { to } = ACTIONS[input.action];
    requireStart(input.action, agent.status);
    const decision = transitionAgent(agent.status, to, reason);
    if (!decision.ok) throw refusal(decision.errors);
    const events: OutboxMessage[] = [];
    const trail: AuditEntry[] = [
      audit(actorId, 'agent.status_changed', 'agent', agent.id, now, { before: agent.status, after: to }),
    ];

    if (input.action === 'suspend' || input.action === 'deactivate') {
      const agenda = (await tx.agendas([agent.id], { start: now, end: null })).get(agent.id) ?? [];
      let toRelease: string[];
      if (input.action === 'suspend') {
        toRelease = suspensionRelease({ assignments: agenda, now }).toRelease;
      } else {
        const check = checkDeactivation({ assignments: agenda, reassign: input.reassign ?? false, now });
        if (!check.ok) throw refusal(check.errors);
        toRelease = check.value.toReassign;
      }
      const released = await releaseAssignments(tx, await assignmentsByIds(tx, toRelease), {
        actorId,
        by: actorId,
        reason: RELEASE_REASONS[input.action],
        cause: 'agent_deactivated',
        at: now,
      });
      events.push(...released.events);
      trail.push(...released.audit);
    }

    const reviewing = input.action === 'review' || input.action === 'approve' || input.action === 'reject';
    await tx.updateAgent(agent.id, agent.version, {
      status: to,
      statusReason: reason,
      ...(reviewing ? { reviewedBy: actorId, reviewedAt: now } : {}),
      // Agent qui devient actif : attribution du rôle notée avec le statut (retirée à la désactivation).
      ...(roleAssignmentId ? { roleAssignmentId } : {}),
      updatedAt: now,
    });

    if (input.action === 'approve') {
      const codes = [...new Set(input.validatedSkillCodes ?? [])];
      const skills = validatedSkills(agent.skills, codes, false);
      await tx.replaceSkills(agent.id, skills, actorId, now);
      const validated = skills.filter((s) => s.status === 'validated').map((s) => s.code);
      trail.push(audit(actorId, 'agent.skills_validated', 'agent', agent.id, now, { skillCodes: validated }));
      // R-AG-01 : le rôle cleaning_agent est déjà attribué (GrantRole, avant cette écriture) ;
      // l'événement prévient l'agent de sa validation (notification).
      events.push({
        type: 'cleaning.agent.approved',
        payload: {
          agentId: agent.id,
          userId: agent.userId,
          approvedBy: actorId,
          skillCodes: validated,
          employmentKind: agent.employmentKind,
          approvedAt: now.toISOString(),
        },
      });
    }
    return { events, audit: trail };
  }
}
