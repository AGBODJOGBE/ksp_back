import { AppError, type ErrorDetails } from '@ksp/platform';
import { type PlanningError, type PlanningErrorCode } from '../../domain/planning/errors';

/**
 * Erreurs du service (tableau des erreurs de cleaning.proto). Messages en français, pour
 * l'utilisateur ; les détails reprennent les noms du contrat (details.field, details.reason…).
 */
const REASON_MESSAGES: Record<string, string> = {
  required: 'Ce champ est obligatoire.',
  invalid_type: "La valeur n'a pas le bon format.",
  out_of_range: 'Cette valeur est hors des bornes autorisées.',
  duplicate: 'Cette valeur est en double.',
  not_applicable: 'Ce champ ne s’applique pas ici.',
  unknown_parameter: "Ce paramètre n'est pas demandé pour ce lieu ni pour les types choisis.",
  unknown_choice: "Cette valeur n'est pas proposée.",
  team_rule_gap: 'Les tranches de superficie doivent se suivre, de 0 à une dernière tranche ouverte.',
  area_parameter_invalid: 'La superficie doit être un paramètre nombre actif du lieu.',
  unknown_commune: "Cette commune n'existe pas dans le référentiel.",
  pack_item_also_selected: 'Un pack ne se choisit pas avec l’un de ses types.',
};

export const CleaningErrors = {
  /** Champ refusé : details.field et details.reason. */
  validation: (field: string, reason: string) =>
    AppError.invalid('CLEANING_VALIDATION_FAILED', REASON_MESSAGES[reason] ?? 'La requête est invalide.', {
      field,
      reason,
    }),
  idempotencyKeyReused: () =>
    AppError.conflict(
      'CLEANING_IDEMPOTENCY_KEY_REUSED',
      'Cette clé a déjà servi pour une autre opération : utilisez une nouvelle clé.',
    ),
  concurrentUpdate: () =>
    AppError.conflict(
      'CLEANING_CONCURRENT_UPDATE',
      'Cet élément a été modifié en même temps par un autre appel : relisez-le et recommencez.',
    ),
  codeAlreadyUsed: (code: string) =>
    AppError.conflict('CLEANING_CODE_ALREADY_USED', 'Ce code est déjà utilisé.', { code }),
  invalidTransition: (from: string, to: string) =>
    AppError.precondition(
      'CLEANING_INVALID_TRANSITION',
      "Cette action n'est pas possible dans l'état actuel.",
      { from, to },
    ),
  placeCategoryNotFound: () =>
    AppError.notFound('CLEANING_PLACE_CATEGORY_NOT_FOUND', 'Cette catégorie de lieu est introuvable.'),
  placeTypeNotFound: () => AppError.notFound('CLEANING_PLACE_TYPE_NOT_FOUND', 'Ce lieu est introuvable.'),
  cleaningTypeNotFound: () =>
    AppError.notFound('CLEANING_TYPE_NOT_FOUND', 'Ce type de nettoyage est introuvable.'),
  /** details.parameterId (paramètre cité par identifiant) ou details.parameterCode (par code). */
  parameterNotFound: (details?: { parameterId: string } | { parameterCode: string }) =>
    AppError.notFound('CLEANING_PARAMETER_NOT_FOUND', 'Ce paramètre est introuvable.', details),
  offerNotFound: () => AppError.notFound('CLEANING_OFFER_NOT_FOUND', 'Cette offre est introuvable.'),
  tariffNotFound: () =>
    AppError.notFound('CLEANING_TARIFF_NOT_FOUND', 'Cette version de tarif est introuvable.'),
  skillNotFound: (code?: string) =>
    AppError.notFound(
      'CLEANING_SKILL_NOT_FOUND',
      'Cette compétence est introuvable.',
      code ? { code } : undefined,
    ),
  holidayNotFound: () => AppError.notFound('CLEANING_HOLIDAY_NOT_FOUND', 'Ce jour férié est introuvable.'),
  zoneNotFound: () => AppError.notFound('CLEANING_ZONE_NOT_FOUND', 'Cette zone est introuvable.'),
  offerNotAvailable: (cleaningTypeId: string) =>
    AppError.invalid('CLEANING_OFFER_NOT_AVAILABLE', "Ce type de nettoyage n'est pas proposé pour ce lieu.", {
      cleaningTypeId,
    }),
  tariffIncomplete: (reason: string, index: number | null) =>
    AppError.precondition('CLEANING_TARIFF_INCOMPLETE', 'Ce tarif est incomplet ou incohérent.', {
      reason,
      index,
    }),
  parameterInUse: (offerIds: string[], placeTypeIds: string[]) =>
    AppError.precondition(
      'CLEANING_PARAMETER_IN_USE',
      'Ce paramètre est utilisé par un tarif publié ou un lieu actif : il ne peut être ni resserré, ni privé d’une valeur, ni désactivé.',
      { offerIds, placeTypeIds },
    ),
  zoneHasActivity: (openRequests: number, activePrograms: number) =>
    AppError.conflict(
      'CLEANING_ZONE_HAS_ACTIVITY',
      'Cette zone a des dossiers en cours : confirmez la désactivation.',
      { openRequests, activePrograms },
    ),
  scheduleEmpty: () =>
    AppError.precondition('CLEANING_SCHEDULE_EMPTY', 'Ce programme ne donne aucune date de séance.'),
  scheduleLimitExceeded: (maxMonths: number, maxSessions: number) =>
    AppError.precondition(
      'CLEANING_SCHEDULE_LIMIT_EXCEEDED',
      'Ce programme dépasse la durée ou le nombre de séances autorisés.',
      {
        maxMonths,
        maxSessions,
      },
    ),
  geoUnavailable: () =>
    AppError.unavailable(
      'CLEANING_GEO_UNAVAILABLE',
      'Le référentiel des communes est indisponible pour le moment : réessayez.',
    ),
};

/** Premier défaut d'une liste de champs refusés, ou rien. */
export function throwFirstProblem(problems: readonly { field: string; reason: string }[], prefix = ''): void {
  const first = problems[0];
  if (first) throw CleaningErrors.validation(`${prefix}${first.field}`, first.reason);
}

// --- Agents et planification (lot D) ---------------------------------------------------------

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
