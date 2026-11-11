import { AppError } from '@ksp/platform';
import { type Assignment } from '../../domain/agenda';
import { type PhotoKind } from '../../domain/intervention-changes';

/** Passage ou visite cité dans une erreur : identifiants et dates seulement. */
function assignmentDetails(assignments: readonly Assignment[]) {
  return assignments.map((assignment) => ({
    kind: assignment.kind,
    id: assignment.id,
    missionId: assignment.missionId,
    requestId: assignment.requestId,
    start: assignment.slot.start.toISOString(),
    end: assignment.slot.end.toISOString(),
  }));
}

/** Erreurs des compléments du Nettoyage (ADR-053, en-tête de cleaning.proto). */
export const ComplementErrors = {
  interventionClosed: () =>
    AppError.precondition(
      'CLEANING_INTERVENTION_CLOSED',
      'Ce passage est terminé ou annulé : ses photos ne peuvent plus être modifiées.',
    ),
  photoLimitReached: (kind: PhotoKind, maximum: number) =>
    AppError.precondition(
      'CLEANING_PHOTO_LIMIT_REACHED',
      `Ce passage a déjà ${maximum} photos « ${kind === 'before' ? 'avant' : 'après'} » : retirez-en une pour en ajouter une autre.`,
      { kind, maximum },
    ),
  agentHasAssignments: (assignments: readonly Assignment[]) =>
    AppError.conflict(
      'CLEANING_AGENT_HAS_ASSIGNMENTS',
      'Cet agent a des passages ou des visites à venir : reportez-les ou affectez-les à un autre agent avant de le désactiver.',
      { assignments: assignmentDetails(assignments) },
    ),
  unavailabilityConflict: (assignments: readonly Assignment[]) =>
    AppError.conflict(
      'CLEANING_UNAVAILABILITY_CONFLICT',
      'Cette indisponibilité chevauche des passages ou des visites déjà planifiés. Confirmez pour l’enregistrer quand même, puis reportez-les ou réaffectez-les.',
      { assignments: assignmentDetails(assignments) },
    ),
  unavailabilityNotFound: () =>
    AppError.notFound('CLEANING_UNAVAILABILITY_NOT_FOUND', 'Cette indisponibilité est introuvable.'),
  teamInactive: () =>
    AppError.precondition(
      'CLEANING_TEAM_INACTIVE',
      'Cette équipe est désactivée : choisissez une autre équipe ou des agents.',
    ),
};
