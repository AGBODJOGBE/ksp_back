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
};

export const paymentParams = {
  status: z.enum(['pending', 'succeeded', 'failed', 'expired', 'cancelled', 'amount_mismatch']).optional(),
  subjectType: z.enum(['cleaning_mission', 'billing_invoice']).optional(),
  optionalId: z.guid().optional(),
  /** En-tête X-FEDAPAY-SIGNATURE : présent, borné ; vérifié par payment. */
  signature: z.string().min(1).max(1000),
};
