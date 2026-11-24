import { type AssignmentState, isUpcoming } from '../planning/assignment-status';
import { accepted, type Decision, planningError, refused } from '../planning/errors';

/**
 * Cycle de vie d'un agent de nettoyage (partie 9.1, transitions de 15.2) et compétences validées
 * (R-AG-01). Un agent n'est jamais supprimé (R-AG-03).
 */
export type AgentStatus = 'applicant' | 'under_review' | 'active' | 'suspended' | 'deactivated' | 'rejected';

export const AGENT_STATUSES: readonly AgentStatus[] = [
  'applicant',
  'under_review',
  'active',
  'suspended',
  'deactivated',
  'rejected',
];

/**
 * Transitions autorisées (15.2, décision du 20 novembre 2026 ; « toute autre répond
 * CLEANING_INVALID_TRANSITION ») : applicant → under_review → active ⇄ suspended ; active ou
 * suspended → deactivated ; applicant ou under_review → rejected.
 */
const AGENT_TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  applicant: ['under_review', 'rejected'],
  under_review: ['active', 'rejected'],
  active: ['suspended', 'deactivated'],
  suspended: ['active', 'deactivated'],
  deactivated: [],
  rejected: [],
};

export function canTransitionAgent(from: AgentStatus, to: AgentStatus): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

/** Nouveau statut, ou le refus : transition interdite, ou refus de candidature sans motif. */
export function transitionAgent(
  from: AgentStatus,
  to: AgentStatus,
  reason: string | null,
): Decision<AgentStatus> {
  if (!canTransitionAgent(from, to)) {
    return refused(planningError('CLEANING_INVALID_TRANSITION', { from, to }));
  }
  if (to === 'rejected' && !reason?.trim()) {
    return refused(planningError('CLEANING_REASON_REQUIRED', { field: 'reason' }));
  }
  return accepted(to);
}

export type AgentSkillStatus = 'declared' | 'validated' | 'rejected';

/** Compétences qui comptent pour la planification : validées une par une par l'admin. */
export function validatedSkillCodes(
  skills: readonly { code: string; status: AgentSkillStatus }[],
): Set<string> {
  return new Set(skills.filter((skill) => skill.status === 'validated').map((skill) => skill.code));
}

export interface AgentAssignmentRef extends AssignmentState {
  assignmentId: string;
  /** Fin de la période occupée (fin réelle pour une cible terminée, R-PL-09). */
  end: Date;
}

/**
 * Désactivation (R-AG-03) : refusée tant que l'agent a des affectations à venir, sauf si l'admin
 * demande leur réaffectation automatique ; elles sont alors rendues pour être retirées et replanifiées.
 */
export function checkDeactivation(input: {
  assignments: readonly AgentAssignmentRef[];
  reassign: boolean;
  now: Date;
}): Decision<{ toReassign: string[] }> {
  const upcoming = upcomingAssignmentIds(input.assignments, input.now);
  if (upcoming.length && !input.reassign) {
    return refused(planningError('CLEANING_AGENT_HAS_ASSIGNMENTS', { assignments: upcoming }));
  }
  return accepted({ toReassign: upcoming });
}

/**
 * Suspension (R-AG-03, décision du 20 novembre 2026 : même règle que la désactivation avec
 * réaffectation) : ses affectations à venir, en cours comprise, sont retirées et la planification
 * les réattribue. Le contrat (SuspendAgentRequest) n'a pas d'option « reassign » : la suspension
 * n'est jamais refusée pour ce motif.
 */
export function suspensionRelease(input: { assignments: readonly AgentAssignmentRef[]; now: Date }): {
  toRelease: string[];
} {
  return { toRelease: upcomingAssignmentIds(input.assignments, input.now) };
}

function upcomingAssignmentIds(assignments: readonly AgentAssignmentRef[], now: Date): string[] {
  return assignments
    .filter((assignment) => isUpcoming(assignment, now))
    .map((assignment) => assignment.assignmentId);
}
