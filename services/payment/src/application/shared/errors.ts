import { AppError } from '@ksp/platform';

/** Erreurs du service (contrat gRPC, en-tête de payment.proto). Messages en français. */
export const PaymentErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('PAYMENT_VALIDATION_FAILED', message, { field }),
  notFound: () => AppError.notFound('PAYMENT_NOT_FOUND', 'Ce paiement est introuvable.'),
  subjectNotFound: () =>
    AppError.notFound('PAYMENT_SUBJECT_NOT_FOUND', 'La mission ou la facture à payer est introuvable.'),
  simulationDisabled: () =>
    AppError.notFound(
      'PAYMENT_SIMULATION_DISABLED',
      'La simulation de paiement n’est disponible qu’en développement.',
    ),
  signatureInvalid: () =>
    AppError.invalid(
      'PAYMENT_WEBHOOK_SIGNATURE_INVALID',
      'La signature de la notification est absente, fausse ou trop ancienne.',
    ),
  nothingDue: () => AppError.precondition('PAYMENT_NOTHING_DUE', 'Il n’y a rien à payer pour le moment.'),
  notPayable: () =>
    AppError.precondition('PAYMENT_SUBJECT_NOT_PAYABLE', 'Cet objet ne peut plus être payé (annulé).'),
  viaInvoice: () =>
    AppError.precondition(
      'PAYMENT_VIA_INVOICE',
      'Une prestation d’entreprise se règle par sa facture mensuelle.',
    ),
  keyReused: () =>
    AppError.conflict(
      'PAYMENT_IDEMPOTENCY_KEY_REUSED',
      'Cette clé d’idempotence a déjà servi pour un autre paiement.',
    ),
  alreadyReceived: () =>
    AppError.conflict(
      'PAYMENT_ALREADY_RECEIVED',
      'Un paiement a déjà été reçu pour cet objet et est en cours d’enregistrement. Réessayez dans quelques instants.',
    ),
  /**
   * Paiement réussi toujours pas enregistré par cleaning ou billing après le délai normal (ADR-032) :
   * un nouveau paiement reste refusé (jamais payer deux fois), le client passe par le support.
   */
  reconciliationPending: () =>
    AppError.conflict(
      'PAYMENT_RECONCILIATION_PENDING',
      'Un paiement a déjà été reçu pour cet objet mais son enregistrement prend plus de temps que prévu. ' +
        'Ne payez pas une seconde fois : contactez le support KSP, qui finalisera son enregistrement.',
    ),
  /**
   * Paiement de l'objet en écart de montant (amount_mismatch) pas encore traité par la finance
   * (ADR-032) : aucun nouveau paiement tant qu'elle ne l'a pas traité.
   */
  underReview: () =>
    AppError.conflict(
      'PAYMENT_UNDER_REVIEW',
      'Un paiement est en cours de vérification ; contactez le support KSP.',
    ),
  notAmountMismatch: () =>
    AppError.precondition(
      'PAYMENT_NOT_AMOUNT_MISMATCH',
      'Seul un paiement en écart de montant (amount_mismatch) peut être traité.',
    ),
  mismatchAlreadyResolved: () =>
    AppError.conflict('PAYMENT_MISMATCH_ALREADY_RESOLVED', 'Cet écart de montant a déjà été traité.'),
  concurrentUpdate: () =>
    AppError.conflict(
      'PAYMENT_CONCURRENT_UPDATE',
      'Le paiement a été modifié en même temps par un autre appel. Réessayez.',
    ),
  providerUnavailable: () =>
    AppError.unavailable(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'Le service de paiement est momentanément indisponible. Réessayez dans quelques instants.',
    ),
  callerForbidden: () =>
    AppError.forbidden('PAYMENT_CALLER_FORBIDDEN', "Ce service n'est pas autorisé à appeler cette méthode."),

  // --- Liens de paiement (ADR-040) ---------------------------------------------------------------
  /** Jeton inconnu ou mal formé, ou lien d'un autre émetteur : rien n'est révélé. */
  linkNotFound: () => AppError.notFound('PAYMENT_LINK_NOT_FOUND', 'Ce lien de paiement est introuvable.'),
  linkAlreadyPaid: () =>
    AppError.conflict(
      'PAYMENT_LINK_ALREADY_PAID',
      'Ce paiement a déjà été reçu. Merci, il n’y a rien à payer.',
    ),
  linkAlreadyActive: () =>
    AppError.conflict(
      'PAYMENT_LINK_ALREADY_ACTIVE',
      'Un lien encore payable existe déjà pour cet objet : le révoquer avant d’en créer un autre.',
    ),
  linkRevoked: () =>
    AppError.precondition(
      'PAYMENT_LINK_REVOKED',
      'Ce lien de paiement a été annulé. Contactez l’expéditeur du message pour obtenir un nouveau lien.',
    ),
  linkExpired: () =>
    AppError.precondition(
      'PAYMENT_LINK_EXPIRED',
      'Ce lien de paiement a expiré. Contactez l’expéditeur du message pour obtenir un nouveau lien.',
    ),
  linkTooManyAttempts: () =>
    AppError.rateLimited(
      'PAYMENT_LINK_TOO_MANY_ATTEMPTS',
      'Trop de tentatives de paiement sur ce lien. Réessayez dans une heure.',
    ),

  /** Une page de paiement est déjà ouverte pour l'objet (une seule à la fois, ADR-048). */
  checkoutOpen: (expiresAt: Date) =>
    AppError.conflict(
      'PAYMENT_CHECKOUT_OPEN',
      'Un paiement est déjà en cours pour cet objet. Terminez-le, ou réessayez après son expiration.',
      { expiresAt: expiresAt.toISOString() },
    ),

  // --- Reversements (ADR-041) --------------------------------------------------------------------
  payoutNotFound: () => AppError.notFound('PAYMENT_PAYOUT_NOT_FOUND', 'Ce reversement est introuvable.'),
  payoutNotManual: () =>
    AppError.precondition(
      'PAYMENT_PAYOUT_NOT_MANUAL',
      'Ce reversement est exécuté par le prestataire : son issue ne se saisit pas à la main.',
    ),
  payoutAlreadySettled: () =>
    AppError.conflict('PAYMENT_PAYOUT_ALREADY_SETTLED', 'Ce reversement est déjà terminé.'),
  /**
   * Refus définitif du prestataire (HTTP 4xx hors 408 et 429, ADR-048) : jamais une panne passagère,
   * l'opération n'est pas réessayée. Usage interne (reversements).
   */
  providerRejected: (httpStatus: number) =>
    AppError.precondition('PAYMENT_PROVIDER_REJECTED', 'Le prestataire de paiement a refusé l’opération.', {
      httpStatus,
    }),
};

/** Refus définitif du prestataire : son statut HTTP, sinon null (panne ou autre erreur). */
export function rejectedStatus(error: unknown): number | null {
  if (!(error instanceof AppError) || error.code !== 'PAYMENT_PROVIDER_REJECTED') return null;
  const status = error.details['httpStatus'];
  return typeof status === 'number' ? status : 0;
}
