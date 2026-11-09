import { z } from 'zod';

const money = z.strictObject({
  amount: z.number().int().min(1).max(1_000_000_000),
  currency: z.literal('XOF'),
});

/** Corps des routes du portefeuille prépayé (ADR-046), repris du contrat OpenAPI. */
export const walletBodies = {
  createWalletTopUp: z.strictObject({ amount: money }),
  creditPrepaidWallet: z.strictObject({
    kind: z.enum(['refund', 'top_up']),
    amount: money,
    reason: z.string().min(1).max(200),
    paymentId: z.guid().optional(),
  }),
};
