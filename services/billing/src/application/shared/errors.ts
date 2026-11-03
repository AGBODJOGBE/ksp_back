import { AppError } from '@ksp/platform';

/** Erreurs du service (contrat gRPC, en-tête de billing.proto). Messages en français. */
export const BillingErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('BILLING_VALIDATION_FAILED', message, { field }),
  invoiceNotFound: () => AppError.notFound('BILLING_INVOICE_NOT_FOUND', 'Cette facture est introuvable.'),
  paymentInvalid: (reason: string) =>
    AppError.invalid('BILLING_PAYMENT_INVALID', 'Ce paiement ne peut pas être enregistré.', { reason }),
  invalidTransition: (from: string, to: string) =>
    AppError.precondition(
      'BILLING_INVALID_TRANSITION',
      "Cette action n'est pas possible dans l'état actuel de la facture.",
      { from, to },
    ),
  callerForbidden: () =>
    AppError.forbidden('BILLING_CALLER_FORBIDDEN', "Ce service n'est pas autorisé à appeler cette méthode."),
  /**
   * Événement de cleaning (annulation, suspension, reprise) arrivé avant la confirmation de la
   * mission d'organisation : réessayable. Levée par un consommateur, jamais rendue à un appelant :
   * l'événement n'est pas marqué traité et repasse par la file de reprise (ADR-005, ADR-032).
   */
  contractNotYetRegistered: (missionId: string) =>
    AppError.unavailable(
      'BILLING_CONTRACT_NOT_YET_REGISTERED',
      'Le contrat de cette mission n’est pas encore enregistré : l’événement sera traité à nouveau.',
      { missionId },
    ),
  concurrentUpdate: () =>
    AppError.conflict(
      'BILLING_CONCURRENT_UPDATE',
      'La facture a été modifiée en même temps par un autre appel. Réessayez.',
    ),
};
