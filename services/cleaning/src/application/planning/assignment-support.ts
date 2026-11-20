import { validatedSkillCodes } from '../../domain/agents/agent';
import { type AgendaEntry, type TargetRef, type TravelTime } from '../../domain/planning/agenda';
import {
  type AgentCheck,
  type CheckResult,
  type PlanningAgent,
  type PlanningContext,
} from '../../domain/planning/assignment-check';
import { effectiveAssignmentStatus } from '../../domain/planning/assignment-status';
import { type PlanningError } from '../../domain/planning/errors';
import { addMinutes } from '../../domain/planning/time';
import { type AgentRecord } from '../agents/agent.ports';
import { cleaningErrors, refusal } from '../shared/errors';
import { type AuditEntry, type OutboxMessage } from '../ports';
import {
  type AssignmentRecord,
  type AssignmentSource,
  type PlanningReader,
  type PlanningTx,
  type TargetRecord,
} from './planning.ports';

/**
 * Outils communs aux cas d'usage des affectations : lecture des agents et des cibles, vues
 * rendues au back-office (contrôles, affectations), événements et libération d'affectations.
 */

const DAY_MINUTES = 1440;

/** Agent tel que le domaine le contrôle, avec son agenda. */
export function planningAgent(agent: AgentRecord, agenda: readonly AgendaEntry[]): PlanningAgent {
  return {
    agentId: agent.id,
    status: agent.status,
    employmentKind: agent.employmentKind,
    validatedSkills: [...validatedSkillCodes(agent.skills)],
    zoneKeys: agent.zoneKeys,
    weekly: agent.weekly,
    extras: agent.extras,
    unavailabilities: agent.unavailabilities,
    maxHoursPerDay: agent.maxHoursDay,
    maxHoursPerWeek: agent.maxHoursWeek,
    agenda,
  };
}

/**
 * Fenêtre d'agenda à lire pour des cibles : la semaine ISO de chacune (charge, R-DS-03) et le
 * trajet de part et d'autre ; huit jours de marge couvrent les deux.
 */
export function agendaWindow(targets: readonly { start: Date; end: Date }[]): { start: Date; end: Date } {
  const start = Math.min(...targets.map((t) => t.start.getTime()));
  const end = Math.max(...targets.map((t) => t.end.getTime()));
  return {
    start: addMinutes(new Date(start), -8 * DAY_MINUTES),
    end: addMinutes(new Date(end), 8 * DAY_MINUTES),
  };
}

/** Cibles demandées, toutes trouvées ; sinon CLEANING_VISIT_NOT_FOUND ou CLEANING_SESSION_NOT_FOUND. */
export async function requireTargets(
  reader: PlanningReader,
  refs: readonly TargetRef[],
): Promise<TargetRecord[]> {
  const found = await reader.targets(refs);
  for (const ref of refs) {
    if (!found.some((t) => t.target.kind === ref.kind && t.target.id === ref.id)) {
      throw ref.kind === 'visit' ? cleaningErrors.visitNotFound() : cleaningErrors.sessionNotFound();
    }
  }
  return found;
}

/** Agents demandés, tous trouvés ; sinon CLEANING_AGENT_NOT_FOUND. */
export async function requireAgents(reader: PlanningReader, ids: readonly string[]): Promise<AgentRecord[]> {
  const agents = await reader.agentsByIds(ids);
  if (agents.length !== new Set(ids).size) throw cleaningErrors.agentNotFound();
  return ids.map((id) => agents.find((a) => a.id === id)!);
}

/** Agents de la planification, avec l'agenda lu dans la fenêtre des cibles. */
export async function planningAgents(
  reader: PlanningReader,
  agents: readonly AgentRecord[],
  targets: readonly TargetRecord[],
): Promise<PlanningAgent[]> {
  const agendas = await reader.agendas(
    agents.map((a) => a.id),
    agendaWindow(targets),
  );
  return agents.map((agent) => planningAgent(agent, agendas.get(agent.id) ?? []));
}

/** Lieux dont le trajet peut compter : ceux des cibles et des agendas des agents. */
export function placesOf(targets: readonly TargetRecord[], agents: readonly PlanningAgent[]): string[] {
  return [
    ...new Set([...targets.map((t) => t.placeId), ...agents.flatMap((a) => a.agenda.map((e) => e.placeId))]),
  ];
}

export async function planningContext(
  reader: PlanningReader,
  travel: TravelTime,
  now: Date,
): Promise<PlanningContext> {
  const settings = await reader.settings();
  return {
    now,
    travel,
    defaultTravelMinutes: settings.defaultTravelMinutes,
    assignmentResponseHours: settings.assignmentResponseHours,
  };
}

// ---------------------------------------------------------------------------------------------
// Vues rendues (JSON, dates ISO) : réponses rejouables d'une requête idempotente.
// ---------------------------------------------------------------------------------------------

export interface ScheduleConflictView {
  target: TargetRef;
  start: string;
  end: string;
  travelMinutes: number;
}

export interface CheckResultView {
  check: string;
  passed: boolean;
  overridable: boolean;
  overridden: boolean;
  missingSkills: string[];
  conflicts: ScheduleConflictView[];
  unavailabilityId: string | null;
  unavailabilityStart: string | null;
  unavailabilityEnd: string | null;
}

export interface AgentCheckView {
  agentId: string;
  target: TargetRef;
  passed: boolean;
  results: CheckResultView[];
}

export function checkResultView(result: CheckResult): CheckResultView {
  const [leave] = result.unavailabilities;
  return {
    check: result.check,
    passed: result.passed,
    overridable: result.overridable,
    overridden: result.overridden,
    missingSkills: [...result.missingSkills],
    conflicts: result.conflicts.map((c) => ({
      target: c.target,
      start: c.start.toISOString(),
      end: c.end.toISOString(),
      travelMinutes: c.travelMinutes,
    })),
    unavailabilityId: leave?.id ?? null,
    unavailabilityStart: leave?.start.toISOString() ?? null,
    unavailabilityEnd: leave?.end.toISOString() ?? null,
  };
}

export function agentCheckView(check: AgentCheck): AgentCheckView {
  return {
    agentId: check.agentId,
    target: check.target,
    passed: check.passed,
    results: check.results.map(checkResultView),
  };
}

/** Refus du domaine, contrôles rendus dans details.checks comme dans la réponse (contrat). */
export function planningRefusal(errors: readonly PlanningError[]) {
  return refusal(
    errors.map((error) =>
      Array.isArray(error.details.checks)
        ? {
            ...error,
            details: { ...error.details, checks: (error.details.checks as AgentCheck[]).map(agentCheckView) },
          }
        : error,
    ),
  );
}

export interface AssignmentView {
  id: string;
  target: TargetRef;
  agentId: string;
  agentName: string;
  isLead: boolean;
  source: 'manual' | 'auto';
  status: string;
  respondBefore: string | null;
  overrides: { check: string; reason: string }[];
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export function assignmentView(
  assignment: AssignmentRecord,
  agentName: string,
  createdByName: string | null,
  now: Date,
): AssignmentView {
  return {
    id: assignment.id,
    target: assignment.target,
    agentId: assignment.agentId,
    agentName,
    isLead: assignment.isLead,
    source: assignment.source,
    status: effectiveAssignmentStatus(assignment, now),
    respondBefore: assignment.respondBefore?.toISOString() ?? null,
    overrides: assignment.overrides.map((check) => ({ check, reason: assignment.reason ?? '' })),
    createdBy: assignment.createdBy,
    createdByName,
    createdAt: assignment.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Événements.
// ---------------------------------------------------------------------------------------------

/** Lead et agents en vigueur d'une cible relue après l'écriture. */
function team(target: TargetRecord) {
  return {
    agentIds: target.assignments.map((a) => a.agentId),
    leadAgentId: target.assignments.find((a) => a.isLead)?.agentId ?? null,
  };
}

/** Agents d'une séance (cleaning.session.assigned) ou d'une visite (cleaning.visit.scheduled). */
export function assignedEvent(
  target: TargetRecord,
  now: Date,
  batchId: string | null,
  source: AssignmentSource = 'manual',
): OutboxMessage {
  const { agentIds, leadAgentId } = team(target);
  if (target.target.kind === 'visit') return visitScheduled(target, []);
  return {
    type: 'cleaning.session.assigned',
    payload: {
      sessionId: target.target.id,
      programId: target.programId!,
      customerId: target.customerId,
      organizationId: target.organizationId,
      rank: target.rank!,
      scheduledStart: target.start.toISOString(),
      agentIds,
      leadAgentId,
      source,
      assignedAt: now.toISOString(),
      programNumber: target.number,
      sessionsCount: target.sessionsCount!,
      batchId,
      teamIncomplete: agentIds.length < (target.expectedTeamSize ?? 0),
    },
  };
}

/** Visite planifiée : agents en vigueur, et ceux qu'un changement retire. */
function visitScheduled(target: TargetRecord, releasedAgentIds: string[]): OutboxMessage {
  return {
    type: 'cleaning.visit.scheduled',
    payload: {
      visitId: target.target.id,
      requestId: target.requestId,
      requestNumber: target.number,
      customerId: target.customerId,
      organizationId: target.organizationId,
      agentIds: team(target).agentIds,
      scheduledAt: target.start.toISOString(),
      durationMinutes: Math.round((target.end.getTime() - target.start.getTime()) / 60_000),
      previousScheduledAt: null,
      releasedAgentIds,
      placeTypeName: target.placeTypeName,
      cleaningTypeNames: target.cleaningTypes.map((t) => t.name),
    },
  };
}

export type UnassignCause =
  'manual' | 'unavailability' | 'agent_deactivated' | 'agent_declined' | 'no_response' | 'rescheduled';

/** Agents retirés d'une séance (cleaning.session.unassigned) ou d'une visite. */
export function unassignedEvent(
  target: TargetRecord,
  agentIds: string[],
  cause: UnassignCause,
  now: Date,
): OutboxMessage {
  if (target.target.kind === 'visit') return visitScheduled(target, agentIds);
  return {
    type: 'cleaning.session.unassigned',
    payload: {
      sessionId: target.target.id,
      programId: target.programId!,
      customerId: target.customerId,
      organizationId: target.organizationId,
      agentIds,
      cause,
      unassignedAt: now.toISOString(),
      programNumber: target.number,
      rank: target.rank!,
      sessionsCount: target.sessionsCount!,
      scheduledStart: target.start.toISOString(),
      batchId: null,
    },
  };
}

export function audit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  at: Date,
  details?: Record<string, unknown>,
): AuditEntry {
  return { actorId, action, entityType, entityId, at, ...(details ? { details } : {}) };
}

/**
 * Après le départ d'agents d'une cible (retrait, refus de l'indépendant) : une séance dont l'équipe
 * devient incomplète repasse « à affecter » (UC-NT-37) ; événement de retrait. La planification
 * automatique qui relance la recherche (R-PL-01) relève du lot G.
 */
export async function afterDeparture(
  tx: PlanningTx,
  departures: readonly { target: TargetRef; agentId: string }[],
  cause: UnassignCause,
  now: Date,
): Promise<OutboxMessage[]> {
  const refs = uniqueTargets(departures.map((d) => d.target));
  const events: OutboxMessage[] = [];
  for (const target of await tx.targets(refs)) {
    const agentIds = departures.filter((d) => sameTarget(d.target, target.target)).map((d) => d.agentId);
    if (
      target.target.kind === 'session' &&
      target.status === 'assigned' &&
      target.assignments.length < (target.expectedTeamSize ?? 1)
    ) {
      await tx.setSessionStatus(target.target.id, 'to_assign', now);
    }
    events.push(unassignedEvent(target, agentIds, cause, now));
  }
  return events;
}

/**
 * Retrait d'affectations (statut removed, motif et auteur) suivi de ses conséquences sur les
 * cibles ; traces assignment.removed. `by` null pour un retrait système.
 */
export async function releaseAssignments(
  tx: PlanningTx,
  assignments: readonly AssignmentRecord[],
  removal: { actorId: string; by: string | null; reason: string; cause: UnassignCause; at: Date },
): Promise<{ events: OutboxMessage[]; audit: AuditEntry[] }> {
  if (!assignments.length) return { events: [], audit: [] };
  await tx.removeAssignments(
    assignments.map((a) => a.id),
    { by: removal.by, reason: removal.reason, at: removal.at },
  );
  const events = await afterDeparture(tx, assignments, removal.cause, removal.at);
  return {
    events,
    audit: assignments.map((a) =>
      audit(removal.actorId, 'assignment.removed', 'assignment', a.id, removal.at, {
        target: a.target,
        agentId: a.agentId,
        before: a.status,
        after: 'removed',
        cause: removal.cause,
      }),
    ),
  };
}

/** Affectations enregistrées qui correspondent aux identifiants d'agenda. */
export async function assignmentsByIds(
  reader: PlanningReader,
  ids: readonly string[],
): Promise<AssignmentRecord[]> {
  const found = await Promise.all(ids.map((id) => reader.assignment(id)));
  return found.filter((a): a is AssignmentRecord => a !== null);
}

export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function uniqueTargets(refs: readonly TargetRef[]): TargetRef[] {
  return refs.filter((ref, index) => refs.findIndex((other) => sameTarget(ref, other)) === index);
}
