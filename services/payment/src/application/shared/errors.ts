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
};
