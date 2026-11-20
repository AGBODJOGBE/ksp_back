import { AppError } from '@ksp/platform';

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
