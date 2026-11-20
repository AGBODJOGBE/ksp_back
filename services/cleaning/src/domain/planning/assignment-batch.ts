import { type AgendaEntry } from './agenda';
import {
  type CheckOverride,
  checkTarget,
  type PlanningAgent,
  type PlanningContext,
  type PlanningTarget,
  type TargetCheck,
} from './assignment-check';
import { type PlanningError, planningError } from './errors';
import { comparePlanningOrder } from './order';

/**
 * Affectation d'une ou plusieurs cibles par un même appel (9.5, R-PL-11) : CheckAssignment,
 * CreateAssignments. L'appelant tient le verrou de l'agenda des agents concernés et fournit leurs
 * affectations relues sous ce verrou (RV-75).
 */
export interface AssignmentRequest {
  targets: readonly PlanningTarget[];
  /** Agents désignés, ou membres de l'équipe. */
  agents: readonly PlanningAgent[];
  team: { teamId: string; active: boolean; leadAgentId: string } | null;
  leadAgentId: string | null;
  overrides: readonly CheckOverride[];
  /** Écarter les cibles en échec au lieu de tout refuser. */
  skipFailing: boolean;
}

export interface BatchOutcome {
  /** Vrai si au moins une cible est à écrire et que rien n'interdit l'appel. */
  ok: boolean;
  /** Tous les motifs de refus ; ceux d'une cible portent details.target. */
  errors: PlanningError[];
  /** Cibles à écrire (vide si l'appel est refusé). */
  retained: TargetCheck[];
  /** Cibles écartées (skipFailing seulement). */
  skipped: TargetCheck[];
  /** Contrôles de toutes les cibles, dans l'ordre chronologique. */
  checks: TargetCheck[];
}

function requestErrors(request: AssignmentRequest): PlanningError[] {
  const errors: PlanningError[] = [];
  if (!request.targets.length) {
    errors.push(planningError('CLEANING_VALIDATION_FAILED', { field: 'targets', reason: 'required' }));
  }
  if (!request.agents.length && request.team === null) {
    errors.push(planningError('CLEANING_VALIDATION_FAILED', { field: 'agentIds', reason: 'required' }));
  }
  return errors;
}

/**
 * Lignes à écrire pour une cible retenue : une affectation par agent, avec son statut (R-PL-08), son
 * trajet et le début de sa période occupée (assignments_no_overlap), et l'entrée d'agenda qui la
 * représente pour les contrôles suivants.
 */
export function agendaEntriesFor(
  check: TargetCheck,
  target: PlanningTarget,
): { agentId: string; isLead: boolean; occupiedFrom: Date; entry: AgendaEntry }[] {
  return check.agentChecks.map((agentCheck) => ({
    agentId: agentCheck.agentId,
    isLead: agentCheck.agentId === check.leadAgentId,
    occupiedFrom: agentCheck.occupied.start,
    entry: {
      assignmentId: `pending:${target.target.kind}:${target.target.id}:${agentCheck.agentId}`,
      target: target.target,
      placeId: target.placeId,
      start: target.start,
      end: target.end,
      travelMinutes: agentCheck.travelMinutes,
      status: agentCheck.status,
      respondBefore: agentCheck.respondBefore,
    },
  }));
}

/**
 * Contrôle d'un lot : les cibles sont contrôlées dans l'ordre chronologique et chaque cible retenue
 * occupe l'agenda, trajet compris, pour les suivantes. Tout ou rien, sauf skipFailing.
 */
export function planAssignments(request: AssignmentRequest, context: PlanningContext): BatchOutcome {
  const errors = requestErrors(request);
  if (errors.length) return { ok: false, errors, retained: [], skipped: [], checks: [] };
  request.overrides.forEach((override, index) => {
    if (!override.reason.trim()) {
      errors.push(planningError('CLEANING_REASON_REQUIRED', { field: `overrides[${index}].reason` }));
    }
  });
  if (request.team && !request.team.active) errors.push(planningError('CLEANING_TEAM_INACTIVE'));

  const agents = new Map(
    request.agents.map((agent) => [agent.agentId, { ...agent, agenda: [...agent.agenda] }]),
  );
  const checks: TargetCheck[] = [];
  for (const target of [...request.targets].sort(comparePlanningOrder)) {
    const check = checkTarget({
      target,
      agents: request.agents.map((agent) => agents.get(agent.agentId)!),
      mode: request.team ? 'team' : 'agents',
      teamLeadId: request.team?.leadAgentId ?? null,
      leadAgentId: request.leadAgentId,
      overrides: request.overrides,
      context,
    });
    checks.push(check);
    if (!check.passed) continue;
    for (const { agentId, entry } of agendaEntriesFor(check, target)) agents.get(agentId)!.agenda.push(entry);
  }

  const passing = checks.filter((check) => check.passed);
  const failing = checks.filter((check) => !check.passed);
  errors.push(
    ...failing.flatMap((check) =>
      check.errors.map((error) => ({ ...error, details: { ...error.details, target: check.target } })),
    ),
  );
  const writable = errors.length === 0 || (request.skipFailing && errors.every((e) => 'target' in e.details));
  const ok = writable && passing.length > 0;
  return {
    ok,
    errors,
    retained: ok ? passing : [],
    skipped: ok && request.skipFailing ? failing : [],
    checks,
  };
}
