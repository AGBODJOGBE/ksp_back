import { type AssignmentState, isInForce } from './assignment-status';
import { addMinutes } from './time';

/**
 * Libération de l'agenda (R-PL-09, RV-65) : une séance ou une visite annulée, une demande close ou un
 * programme arrêté retire ses affectations en vigueur dans la même transaction, avec un motif
 * système. Une cible réalisée ou manquée garde ses affectations, dont la période occupée s'arrête à
 * la fin réelle.
 */
export type ReleaseCause =
  'session_cancelled' | 'program_cancelled' | 'visit_cancelled' | 'request_closed' | 'program_suspended';

/** Affectations à passer « removed » (removed_by null, removal_reason = cause). */
export function releaseAssignments(
  assignments: readonly (AssignmentState & { assignmentId: string })[],
  cause: ReleaseCause,
  now: Date,
): { assignmentId: string; removalReason: ReleaseCause }[] {
  return assignments
    .filter((assignment) => isInForce(assignment, now))
    .map((assignment) => ({ assignmentId: assignment.assignmentId, removalReason: cause }));
}

/** Fin de la période occupée à la clôture : la fin réelle, au moins 1 min après son début (période non vide). */
export function occupiedUntilAtClose(occupiedFrom: Date, completedAt: Date): Date {
  const minimum = addMinutes(occupiedFrom, 1);
  return completedAt > minimum ? completedAt : minimum;
}
