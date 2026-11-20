import { z } from 'zod';

const money = z.strictObject({
  amount: z.number().int().min(1).max(1_000_000_000),
  currency: z.literal('XOF'),
});

const reason = z.strictObject({ reason: z.string().min(1).max(500) });

/** Corps des routes du portefeuille prépayé (ADR-046), repris du contrat OpenAPI. */
export const walletBodies = {
  createWalletTopUp: z.strictObject({ amount: money }),
  creditPrepaidWallet: z.strictObject({
    kind: z.enum(['refund', 'top_up', 'cash_top_up', 'bank_transfer_top_up']),
    amount: money,
    reason: z.string().min(1).max(200),
    paymentId: z.guid().optional(),
    // v2 (R-WL-02, R-PE-04) : reçu des espèces ou du virement, objet à régler aussitôt.
    receiptReference: z.string().min(1).max(100).optional(),
    forObject: z
      .strictObject({
        service: z
          .string()
          .regex(/^[a-z]+$/)
          .optional(),
        objectType: z.string().regex(/^[a-z0-9_]{3,50}$/),
        objectId: z.guid(),
        part: z.string().nullable().optional(),
      })
      .optional(),
  }),
  // Retraits vers Mobile Money (R-WL-04).
  requestWithdrawal: z.strictObject({
    amount: money,
    beneficiary: z.strictObject({
      phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
      operator: z.enum(['mtn', 'moov', 'celtiis']),
      name: z.string().min(1).max(120),
    }),
  }),
  processWithdrawal: z.strictObject({ note: z.string().min(1).max(500) }),
  rejectWithdrawal: reason,
  rejectManualCredit: reason,
};

/** Statut d'un retrait, filtre des listes. */
export const withdrawalStatus = z
  .enum(['requested', 'awaiting_approval', 'submitted', 'completed', 'failed', 'rejected'])
  .optional();
