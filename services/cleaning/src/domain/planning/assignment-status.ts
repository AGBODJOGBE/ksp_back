import { accepted, type Decision, planningError, refused } from './errors';

/**
 * Statut d'une affectation (valeurs du contrat Assignment.status) et réponse de l'indépendant
 * (R-PL-08). Le statut lu tient compte de l'heure (15.2) : une attente sans réponse au-delà de
 * respondBefore est expirée, même avant le passage de la tâche.
 */
export type AssignmentStatus =
  'proposed' | 'pending_confirmation' | 'confirmed' | 'declined' | 'expired' | 'removed';

/** Salarié ou indépendant partenaire (partie 9.1). */
export type EmploymentKind = 'employee' | 'independent';

/** Statuts qui occupent l'agenda de l'agent (contrainte assignments_no_overlap). */
export const IN_FORCE_STATUSES: readonly AssignmentStatus[] = [
  'proposed',
  'pending_confirmation',
  'confirmed',
];

export interface AssignmentState {
  status: AssignmentStatus;
  /** Échéance de réponse d'un indépendant ; null sinon. */
  respondBefore: Date | null;
}

const HOUR_MS = 3_600_000;

export function effectiveAssignmentStatus(assignment: AssignmentState, now: Date): AssignmentStatus {
  if (
    assignment.status === 'pending_confirmation' &&
    assignment.respondBefore !== null &&
    now > assignment.respondBefore
  ) {
    return 'expired';
  }
  return assignment.status;
}

export function isInForce(assignment: AssignmentState, now: Date): boolean {
  return IN_FORCE_STATUSES.includes(effectiveAssignmentStatus(assignment, now));
}

/** Affectation à venir (R-AG-03) : en vigueur et dont la fin est après maintenant, en cours comprise. */
export function isUpcoming(assignment: AssignmentState & { end: Date }, now: Date): boolean {
  return isInForce(assignment, now) && assignment.end > now;
}

/** Statut d'une affectation enregistrée : confirmée d'office pour un salarié, en attente pour un indépendant. */
export function initialAssignmentStatus(
  employmentKind: EmploymentKind,
  now: Date,
  responseHours: number,
): AssignmentState {
  if (employmentKind === 'employee') return { status: 'confirmed', respondBefore: null };
  return { status: 'pending_confirmation', respondBefore: new Date(now.getTime() + responseHours * HOUR_MS) };
}

/** Acceptation ou refus de l'indépendant, seulement tant que l'affectation attend sa réponse. */
export function respondToAssignment(
  assignment: AssignmentState,
  answer: 'accept' | 'decline',
  now: Date,
): Decision<AssignmentStatus> {
  const to: AssignmentStatus = answer === 'accept' ? 'confirmed' : 'declined';
  const from = effectiveAssignmentStatus(assignment, now);
  if (from !== 'pending_confirmation') {
    return refused(planningError('CLEANING_INVALID_TRANSITION', { from, to }));
  }
  return accepted(to);
}
