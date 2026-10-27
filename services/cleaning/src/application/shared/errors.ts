import { AppError } from '@ksp/platform';

/** Erreurs du service (contrat gRPC, en-tête de cleaning.proto). Messages en français, pour l'utilisateur. */
export const CleaningErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('CLEANING_VALIDATION_FAILED', message, { field }),
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
  paymentViaInvoice: () =>
    AppError.precondition(
      'CLEANING_PAYMENT_VIA_INVOICE',
      "Une mission d'entreprise se règle par sa facture mensuelle : enregistrez le paiement sur la facture.",
    ),
  contractSuspended: () =>
    AppError.precondition(
      'CLEANING_CONTRACT_SUSPENDED',
      'Cette mission est suspendue pour impayés : aucun passage ne peut être planifié avant régularisation.',
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
};
