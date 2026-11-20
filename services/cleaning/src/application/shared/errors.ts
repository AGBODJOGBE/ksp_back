import { AppError, type ErrorDetails } from '@ksp/platform';
import { type PlanningError, type PlanningErrorCode } from '../../domain/planning/errors';

/**
 * Erreurs du service (tableau des erreurs de cleaning.proto). Les motifs de refus du domaine
 * (PlanningError) gardent leur code et leurs détails ; seule la nature (statut gRPC) est ajoutée ici.
 */
export const cleaningErrors = {
  invalid: (field: string, reason: string, message = 'Requête invalide.') =>
    AppError.invalid('CLEANING_VALIDATION_FAILED', message, { field, reason }),
  reasonRequired: (field = 'reason') =>
    AppError.invalid('CLEANING_REASON_REQUIRED', 'Le motif est obligatoire.', { field }),
  agentNotFound: () => AppError.notFound('CLEANING_AGENT_NOT_FOUND', 'Agent introuvable.'),
  teamNotFound: () => AppError.notFound('CLEANING_TEAM_NOT_FOUND', 'Équipe introuvable.'),
  assignmentNotFound: () => AppError.notFound('CLEANING_ASSIGNMENT_NOT_FOUND', 'Affectation introuvable.'),
  unavailabilityNotFound: () =>
    AppError.notFound('CLEANING_UNAVAILABILITY_NOT_FOUND', 'Indisponibilité introuvable.'),
  visitNotFound: () => AppError.notFound('CLEANING_VISIT_NOT_FOUND', 'Visite introuvable.'),
  sessionNotFound: () => AppError.notFound('CLEANING_SESSION_NOT_FOUND', 'Séance introuvable.'),
  skillNotFound: (codes: readonly string[]) =>
    AppError.notFound('CLEANING_SKILL_NOT_FOUND', 'Compétence inconnue.', { codes }),
  zoneNotFound: (keys: readonly string[]) =>
    AppError.notFound('CLEANING_ZONE_NOT_FOUND', 'Zone inconnue.', { zoneKeys: keys }),
  alreadyRegistered: () =>
    AppError.conflict('CLEANING_AGENT_ALREADY_REGISTERED', 'Ce compte a déjà un profil d’agent.'),
  concurrentUpdate: () =>
    AppError.conflict(
      'CLEANING_CONCURRENT_UPDATE',
      'Le dossier a été modifié en même temps par un autre appel : relisez et recommencez.',
    ),
  idempotencyKeyReused: () =>
    AppError.conflict(
      'CLEANING_IDEMPOTENCY_KEY_REUSED',
      'Cette clé d’idempotence a déjà servi pour une autre opération ou un autre contenu.',
    ),
};

const KINDS: Readonly<Record<PlanningErrorCode, 'invalid' | 'conflict' | 'precondition'>> = {
  CLEANING_VALIDATION_FAILED: 'invalid',
  CLEANING_REASON_REQUIRED: 'invalid',
  CLEANING_INVALID_TRANSITION: 'precondition',
  CLEANING_AGENT_NOT_ACTIVE: 'precondition',
  CLEANING_SKILL_MISSING: 'precondition',
  CLEANING_AGENT_OUT_OF_ZONE: 'precondition',
  CLEANING_AGENT_UNAVAILABLE: 'precondition',
  CLEANING_AGENT_ON_LEAVE: 'precondition',
  CLEANING_AGENT_OVERLOADED: 'precondition',
  CLEANING_TEAM_SIZE_MISMATCH: 'precondition',
  CLEANING_TEAM_INACTIVE: 'precondition',
  CLEANING_PROGRAM_SUSPENDED: 'precondition',
  CLEANING_SCHEDULE_CONFLICT: 'conflict',
  CLEANING_AGENT_HAS_ASSIGNMENTS: 'conflict',
  CLEANING_UNAVAILABILITY_CONFLICT: 'conflict',
  CLEANING_AVAILABILITY_IN_USE: 'conflict',
};

const MESSAGES: Readonly<Record<PlanningErrorCode, string>> = {
  CLEANING_VALIDATION_FAILED: 'Requête invalide.',
  CLEANING_REASON_REQUIRED: 'Le motif est obligatoire.',
  CLEANING_INVALID_TRANSITION: 'Cette action n’est pas possible dans l’état actuel.',
  CLEANING_AGENT_NOT_ACTIVE: 'Seul un agent actif peut être affecté.',
  CLEANING_SKILL_MISSING: 'L’équipe ne couvre pas toutes les compétences demandées.',
  CLEANING_AGENT_OUT_OF_ZONE: 'La commune du lieu est hors des zones de l’agent.',
  CLEANING_AGENT_UNAVAILABLE: 'La période est hors des disponibilités de l’agent.',
  CLEANING_AGENT_ON_LEAVE: 'L’agent a déclaré une indisponibilité sur la période.',
  CLEANING_AGENT_OVERLOADED: 'La charge maximale de l’agent serait dépassée.',
  CLEANING_TEAM_SIZE_MISMATCH: 'Le nombre d’agents diffère de celui du devis.',
  CLEANING_TEAM_INACTIVE: 'Cette équipe est désactivée.',
  CLEANING_PROGRAM_SUSPENDED: 'Le programme est suspendu.',
  CLEANING_SCHEDULE_CONFLICT: 'L’agent est déjà pris sur la période, temps de trajet compris.',
  CLEANING_AGENT_HAS_ASSIGNMENTS: 'L’agent a encore des affectations à venir.',
  CLEANING_UNAVAILABILITY_CONFLICT: 'L’indisponibilité chevauche des affectations.',
  CLEANING_AVAILABILITY_IN_USE: 'Cette plage est déjà occupée par une affectation.',
};

/** Motif de refus du domaine → AppError, même code et mêmes détails. */
export function planningAppError(error: PlanningError, details: ErrorDetails = error.details): AppError {
  return AppError[KINDS[error.code]](error.code, MESSAGES[error.code], details);
}

/**
 * Refus d'une décision du domaine : le premier motif donne le code ; quand il y en a plusieurs, la
 * liste complète suit dans details.errors (le superviseur voit tous les motifs d'un coup, 9.4).
 */
export function refusal(errors: readonly PlanningError[]): AppError {
  const [first] = errors;
  if (!first) throw new Error('Refus sans motif.');
  const details =
    errors.length > 1
      ? { ...first.details, errors: errors.map((e) => ({ code: e.code, details: e.details })) }
      : first.details;
  return planningAppError(first, details);
}
