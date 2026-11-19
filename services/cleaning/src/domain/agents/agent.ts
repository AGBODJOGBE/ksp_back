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
 * Transitions autorisées, lues dans le tableau de 15.2 (« toute autre répond
 * CLEANING_INVALID_TRANSITION ») : applicant → under_review → active ⇄ suspended → deactivated ;
 * under_review → rejected. Le texte de 9.1 cite aussi « candidat → refusé » et ne dit pas si un
 * agent actif se désactive sans suspension : on s'en tient au tableau, plus restrictif.
 */
const AGENT_TRANSITIONS: Readonly<Record<AgentStatus, readonly AgentStatus[]>> = {
  applicant: ['under_review'],
  under_review: ['active', 'rejected'],
  active: ['suspended'],
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
  const upcoming = input.assignments
    .filter((assignment) => isUpcoming(assignment, input.now))
    .map((assignment) => assignment.assignmentId);
  if (upcoming.length && !input.reassign) {
    return refused(planningError('CLEANING_AGENT_HAS_ASSIGNMENTS', { assignments: upcoming }));
  }
  return accepted({ toReassign: upcoming });
}
