import { AppError } from '@ksp/platform';
import { type AnswerProblemReason } from '../../domain/answers';
import { CURRENCY, formatXof } from '../../domain/money';
import { formatDateTimeFr, formatDayFr, localDay } from '../../domain/schedule';

/** Erreurs du service (contrat gRPC, en-tête de cleaning.proto). Messages en français, pour l'utilisateur. */
const ANSWER_MESSAGES: Record<AnswerProblemReason, string> = {
  unknown_field: 'Ce champ ne fait pas partie du formulaire de la prestation.',
  required: 'Ce champ est obligatoire.',
  invalid_type: "Le type de la réponse n'est pas le bon.",
  out_of_range: 'Cette valeur est hors des bornes autorisées.',
  unknown_choice: "Cette valeur n'est pas proposée.",
  unknown_option: "Cette option n'est pas proposée.",
  duplicate_option: 'Cette option est choisie deux fois.',
  unknown_frequency: "Cette fréquence n'est pas proposée pour cette prestation.",
};

export const CleaningErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('CLEANING_VALIDATION_FAILED', message, { field }),
  /** Réponse au formulaire refusée (ADR-033) : champ et raison. */
  answerRefused: (field: string, reason: AnswerProblemReason) =>
    AppError.invalid('CLEANING_VALIDATION_FAILED', ANSWER_MESSAGES[reason], { field, reason }),
  slotInvalid: (message = 'Le créneau est invalide.') => AppError.invalid('CLEANING_SLOT_INVALID', message),
  serviceNotFound: () => AppError.notFound('CLEANING_SERVICE_NOT_FOUND', 'Cette prestation est introuvable.'),
  requestNotFound: () => AppError.notFound('CLEANING_REQUEST_NOT_FOUND', 'Cette demande est introuvable.'),
  missionNotFound: () => AppError.notFound('CLEANING_MISSION_NOT_FOUND', 'Cette mission est introuvable.'),
  visitNotFound: () => AppError.notFound('CLEANING_VISIT_NOT_FOUND', 'Cette visite est introuvable.'),
  interventionNotFound: () =>
    AppError.notFound('CLEANING_INTERVENTION_NOT_FOUND', 'Ce passage est introuvable.'),
  agentNotFound: (agentIds: string[]) =>
    AppError.notFound('CLEANING_AGENT_NOT_FOUND', 'Agent introuvable ou inactif.', { agentIds }),
  teamNotFound: () => AppError.notFound('CLEANING_TEAM_NOT_FOUND', 'Cette équipe est introuvable.'),
  invalidTransition: (from: string, to: string) =>
    AppError.precondition(
      'CLEANING_INVALID_TRANSITION',
      "Cette action n'est pas possible dans l'état actuel du dossier.",
      { from, to },
    ),
  zoneNotCovered: (commune: string) =>
    AppError.precondition(
      'CLEANING_ZONE_NOT_COVERED',
      "KSP n'intervient pas encore dans cette commune. Le service est ouvert dans les zones desservies.",
      { commune },
    ),
  zoneNotFound: () => AppError.notFound('CLEANING_ZONE_NOT_FOUND', 'Cette zone est introuvable.'),
  placeTypeNotFound: () =>
    AppError.notFound('CLEANING_PLACE_TYPE_NOT_FOUND', 'Ce type de lieu est introuvable.'),
  /** Prestation non proposée pour le type de lieu choisi (ADR-034). */
  serviceNotOffered: (field: string, placeType: string, serviceCode: string) =>
    AppError.invalid(
      'CLEANING_SERVICE_NOT_OFFERED',
      "Cette prestation n'est pas proposée pour ce type de lieu.",
      { field, placeType, serviceCode },
    ),
  /** Position non rattachée à une commune, et aucune commune choisie par le client (ADR-034). */
  locationUnresolved: () =>
    AppError.precondition(
      'CLEANING_LOCATION_UNRESOLVED',
      "Nous n'avons pas pu retrouver la commune de cette position : choisissez votre commune dans la liste des zones desservies.",
    ),
  requestGroupNotFound: () =>
    AppError.notFound('CLEANING_REQUEST_GROUP_NOT_FOUND', 'Ce groupe de demandes est introuvable.'),
  /** Opération de groupe sans aucune demande ou mission concernée (ADR-035). */
  groupNothingEligible: (skipped: readonly object[]) =>
    AppError.precondition(
      'CLEANING_GROUP_NO_ELIGIBLE_REQUEST',
      "Aucune demande du groupe n'est concernée par cette action dans son état actuel.",
      { skipped: skipped.map((entry) => ({ ...entry })) },
    ),
  /** Clé d'idempotence déjà utilisée pour un autre groupe (ADR-035). */
  idempotencyKeyReused: () =>
    AppError.conflict(
      'CLEANING_IDEMPOTENCY_KEY_REUSED',
      'Cette clé a déjà servi pour une autre opération : utilisez une nouvelle clé.',
    ),
  /** Zone avec des demandes ouvertes ou des missions actives, désactivée sans confirmation (ADR-035). */
  zoneHasActivity: (openRequests: number, activeMissions: number) =>
    AppError.conflict(
      'CLEANING_ZONE_HAS_ACTIVITY',
      `Cette zone a ${openRequests} demande(s) ouverte(s) et ${activeMissions} mission(s) active(s) : elles continueront. Confirmez la désactivation.`,
      { openRequests, activeMissions },
    ),
  paymentViaInvoice: () =>
    AppError.precondition(
      'CLEANING_PAYMENT_VIA_INVOICE',
      "Une mission d'entreprise se règle par sa facture mensuelle : enregistrez le paiement sur la facture.",
    ),
  contractSuspended: () =>
    AppError.precondition(
      'CLEANING_CONTRACT_SUSPENDED',
      'Cette mission est suspendue : aucun passage ne peut être planifié avant sa reprise.',
    ),
  organizationSuspended: () =>
    AppError.precondition(
      'CLEANING_ORGANIZATION_SUSPENDED',
      'Ce compte entreprise est suspendu par KSP : aucune demande de nettoyage ne peut être faite en son nom.',
    ),
  quoteExpired: () =>
    AppError.precondition('CLEANING_QUOTE_EXPIRED', 'Ce devis a expiré. Demandez-en un nouveau.'),
  priceNotSet: () =>
    AppError.precondition(
      'CLEANING_PRICE_NOT_SET',
      "Le prix de cette prestation n'est pas encore fixé : complétez les lignes du devis.",
    ),
  visitRequired: () =>
    AppError.precondition(
      'CLEANING_VISIT_REQUIRED',
      'Une visite des lieux doit être réalisée avant d’envoyer le devis.',
    ),
  leadTimeTooShort: (minimumHours: number) =>
    AppError.precondition(
      'CLEANING_LEAD_TIME_TOO_SHORT',
      `Une intervention se réserve au moins ${minimumHours} heures à l'avance.`,
      { minimumHours },
    ),
  cancellationTooLate: (freeCancellationHours: number) =>
    AppError.precondition(
      'CLEANING_CANCELLATION_TOO_LATE',
      `L'annulation n'est plus possible en ligne à moins de ${freeCancellationHours} heures : contactez le support.`,
      { freeCancellationHours },
    ),
  tooManyOpenRequests: (maximum: number) =>
    AppError.precondition(
      'CLEANING_TOO_MANY_OPEN_REQUESTS',
      `Vous avez déjà ${maximum} demandes en cours. Attendez une réponse avant d'en créer une autre.`,
      { maximum },
    ),
  checklistIncomplete: () =>
    AppError.precondition(
      'CLEANING_CHECKLIST_INCOMPLETE',
      'Cochez toute la liste de contrôle avant de clôturer le passage.',
    ),
  noInterventionLeft: () =>
    AppError.precondition('CLEANING_NO_INTERVENTION_LEFT', 'Tous les passages prévus sont déjà planifiés.'),
  teamUnavailable: (agentIds: string[]) =>
    AppError.conflict('CLEANING_TEAM_UNAVAILABLE', 'Un ou plusieurs agents sont déjà pris sur ce créneau.', {
      agentIds,
    }),
  concurrentUpdate: () =>
    AppError.conflict(
      'CLEANING_CONCURRENT_UPDATE',
      'Le dossier vient d’être modifié par ailleurs. Rechargez-le puis réessayez.',
    ),
  agentAlreadyRegistered: () =>
    AppError.conflict('CLEANING_AGENT_ALREADY_REGISTERED', 'Ce compte est déjà rattaché comme agent.'),
  paymentInvalid: (reason: string) =>
    AppError.invalid('CLEANING_PAYMENT_INVALID', 'Ce paiement ne peut pas être enregistré.', { reason }),
  /** Paiement au-delà du reste dû : le montant encore attendu est rappelé (message et détails). */
  paymentExceedsBalance: (remainingDue: number) =>
    AppError.invalid(
      'CLEANING_PAYMENT_INVALID',
      remainingDue > 0
        ? `Ce paiement dépasse le reste dû : ${formatXof(remainingDue)}.`
        : 'Cette mission est déjà entièrement payée : aucun paiement de plus ne peut être enregistré.',
      { reason: 'exceeds_balance', remainingDue: { amount: remainingDue, currency: CURRENCY } },
    ),
  interventionTooEarly: (scheduledStart: Date, timeZone: string) =>
    AppError.precondition(
      'CLEANING_INTERVENTION_TOO_EARLY',
      `Ce passage est prévu le ${formatDayFr(scheduledStart, timeZone)} : il ne peut pas être démarré avant ce jour.`,
      {
        scheduledStart: scheduledStart.toISOString(),
        scheduledDate: localDay(scheduledStart, timeZone),
        timeZone,
      },
    ),
  visitTooEarly: (scheduledAt: Date, timeZone: string) =>
    AppError.precondition(
      'CLEANING_VISIT_TOO_EARLY',
      `La visite est prévue le ${formatDateTimeFr(scheduledAt, timeZone)} : son compte rendu ne peut pas être enregistré avant cette heure.`,
      { scheduledAt: scheduledAt.toISOString(), timeZone },
    ),
};
