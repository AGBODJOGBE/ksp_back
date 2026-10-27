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
  concurrentUpdate: () =>
    AppError.conflict(
      'BILLING_CONCURRENT_UPDATE',
      'La facture a été modifiée en même temps par un autre appel. Réessayez.',
    ),
};
