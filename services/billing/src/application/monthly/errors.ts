import { AppError } from '@ksp/platform';

/** Erreurs du lot F (en-tête de billing.proto). Messages en français. */
export const MonthlyBillingErrors = {
  idempotencyKeyReused: () =>
    AppError.conflict(
      'BILLING_IDEMPOTENCY_KEY_REUSED',
      'Cette clé a déjà servi pour un autre avoir ou une autre facture.',
    ),
  creditNoteExceedsInvoice: (maximum: number) =>
    AppError.precondition(
      'BILLING_CREDIT_NOTE_EXCEEDS_INVOICE',
      'Les avoirs dépasseraient le total de la facture.',
      { maximum },
    ),
};
