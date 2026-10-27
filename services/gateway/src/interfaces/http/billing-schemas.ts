import { z } from 'zod';

/**
 * Corps et paramètres des routes de la facturation, repris du contrat OpenAPI : tout champ
 * inconnu est refusé. Les règles métier (reste dû, état de la facture) restent dans billing.
 */
export const billingBodies = {
  recordInvoicePayment: z.strictObject({
    amount: z.number().int().min(1),
    method: z.enum(['cash', 'bank_transfer', 'mobile_money_offline']),
    reference: z.string().min(0).max(100).optional(),
  }),
  updateBillingSettings: z.strictObject({ paymentTermDays: z.number().int().min(1).max(90) }),
};

export const billingParams = {
  invoiceStatus: z.enum(['pending_payment', 'overdue', 'paid', 'cancelled']).optional(),
  optionalId: z.guid().optional(),
};
