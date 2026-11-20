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
import { type CleaningDeps } from '../deps';
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

/** Changement de statut d'un agent (partie 9.1, transitions de 15.2). */
export class ChangeAgentStatusUseCase {
  constructor(private readonly deps: CleaningDeps) {}

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
      const now = this.deps.clock.now();
      try {
        await this.deps.planning.transaction(async (tx) => {
          await tx.lockAgents([existing.id]);
          const agent = await requireAgent(tx, existing.id);
          const changes = await this.apply(tx, agent, input, reason, actorId, now);
          await tx.write(changes);
          await tx.remember({ ...ref, requestHash: hash, response: { agentId: agent.id } });
        });
      } catch (error) {
        throw writeError(error);
      }
    }
    return agentProfile(this.deps, await requireAgent(this.deps.planning, input.agentId));
  }

  private async apply(
    tx: PlanningTx,
    agent: AgentRecord,
    input: { action: AgentAction; reassign?: boolean; validatedSkillCodes?: string[] },
    reason: string | null,
    actorId: string,
    now: Date,
  ): Promise<{ events: OutboxMessage[]; audit: AuditEntry[] }> {
    const { to, from } = ACTIONS[input.action];
    if (from && agent.status !== from) {
      throw planningAppError(planningError('CLEANING_INVALID_TRANSITION', { from: agent.status, to }));
    }
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
      updatedAt: now,
    });

    if (input.action === 'approve') {
      const codes = [...new Set(input.validatedSkillCodes ?? [])];
      const skills = validatedSkills(agent.skills, codes, false);
      await tx.replaceSkills(agent.id, skills, actorId, now);
      const validated = skills.filter((s) => s.status === 'validated').map((s) => s.code);
      trail.push(audit(actorId, 'agent.skills_validated', 'agent', agent.id, now, { skillCodes: validated }));
      // R-AG-01 : identity donne le rôle cleaning_agent à l'écoute de cet événement.
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
