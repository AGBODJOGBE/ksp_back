import { z } from 'zod';

/**
 * Corps et paramètres des routes du paiement en ligne (ADR-031), repris du contrat OpenAPI : tout
 * champ inconnu est refusé. Jamais de montant : il vient de cleaning ou de billing. La notification
 * du prestataire n'a pas de schéma ici : son corps brut est transmis tel quel (x-ksp-raw-body).
 */
export const paymentBodies = {
  createPayment: z.strictObject({
    subjectType: z.enum(['cleaning_mission', 'billing_invoice']),
    subjectId: z.guid(),
    part: z.enum(['deposit', 'balance']).optional(),
  }),
  simulatePayment: z.strictObject({ outcome: z.enum(['succeeded', 'failed']) }),
  /** Ce que la finance a fait de l'écart (remboursement, encaissement manuel…), ADR-032. */
  resolvePaymentMismatch: z.strictObject({ note: z.string().min(1).max(500) }),
  /** Développement seulement : issue simulée du paiement d'un lien (ADR-040). */
  simulatePaymentLinkPayment: z.strictObject({ outcome: z.enum(['succeeded', 'failed']) }),
  /** Mode manuel : référence du virement fait par la finance (ADR-041). */
  confirmPayout: z.strictObject({ transferReference: z.string().min(1).max(100) }),
  /** Mode manuel : raison de l'échec, jamais transmise dans les événements. */
  failPayout: z.strictObject({ reason: z.string().min(1).max(500) }),
};

export const paymentParams = {
  status: z.enum(['pending', 'succeeded', 'failed', 'expired', 'cancelled', 'amount_mismatch']).optional(),
  /** Types du paiement par compte, ou type de l'émetteur d'un lien (ADR-040). */
  subjectType: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,49}$/)
    .optional(),
  optionalId: z.guid().optional(),
  /** Filtre du back-office : écarts de montant à traiter (true) ou tous les autres (false). */
  underReview: z.enum(['true', 'false']).optional(),
  /** En-tête Idempotency-Key facultatif (traitement d'un écart). */
  optionalIdempotencyKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .optional(),
  /** Jeton d'un lien de paiement : 43 caractères base64url (ADR-040). */
  linkToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  payoutStatus: z.enum(['requested', 'processing', 'completed', 'failed']).optional(),
  issuer: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .max(50)
    .optional(),
  /** En-tête X-FEDAPAY-SIGNATURE : présent, borné ; vérifié par payment. */
  signature: z.string().min(1).max(1000),
};
