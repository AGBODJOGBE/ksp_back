import { AppError } from '@ksp/platform';
import { type WalletEventPayloads } from '@ksp/contracts';
import { balance, type Invoice, type InvoicePayment, withPayment } from '../../domain/invoice';
import { paidEvent } from './invoice-events';
import { type MonthlyBillingDeps } from './ports';

const MAX_ATTEMPTS = 3;

export type WalletCreditOutcome = 'paid' | 'partially_paid' | 'duplicate' | 'left_in_wallet' | 'ignored';

/**
 * R-PE-04, R-WL-05 : un virement ou un paiement Mobile Money destiné à une facture crédite d'abord
 * le portefeuille du titulaire (`wallet.prepaid.credited` v2, forObject service "billing", objet
 * "billing_invoice") ; billing débite aussitôt le reste dû, au plus le montant crédité. Facture
 * déjà soldée, annulée, ou solde insuffisant entre-temps : rien n'est débité, l'argent reste au
 * portefeuille. Idempotent par crédit (clé du débit et du paiement tirées de la transaction).
 */
export class SettleInvoiceFromWalletCreditUseCase {
  constructor(private readonly deps: MonthlyBillingDeps) {}

  async execute(input: {
    payload: WalletEventPayloads['wallet.prepaid.credited'];
  }): Promise<WalletCreditOutcome> {
    const { payload } = input;
    const target = payload.forObject;
    if (!target || target.service !== 'billing' || target.objectType !== 'billing_invoice') return 'ignored';
    let invoice = await this.deps.invoices.findById(target.objectId);
    if (!invoice || !sameHolder(invoice, payload.holder)) return 'ignored';
    const key = `wallet-credit-${payload.transactionId}`;
    if (hasKey(invoice, key)) return 'duplicate';
    if (isClosed(invoice) || balance(invoice) === 0) return 'left_in_wallet';

    let debit;
    try {
      debit = await this.deps.wallet.debit({
        idempotencyKey: `billing_invoice:${invoice.id}:credit:${payload.transactionId}`,
        holder: payload.holder,
        amount: Math.min(balance(invoice), payload.amount.amount),
        object: {
          objectType: 'billing_invoice',
          objectId: invoice.id,
          part: `credit:${payload.transactionId}`,
        },
        description: `Facture ${invoice.number}`,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'WALLET_INSUFFICIENT_FUNDS') return 'left_in_wallet';
      throw error;
    }

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        const current = await this.deps.invoices.findById(invoice.id);
        if (!current) break;
        invoice = current;
        if (hasKey(invoice, key)) return 'duplicate';
      }
      if (isClosed(invoice) || debit.amount > balance(invoice)) break;
      const now = this.deps.clock.now();
      const payment: InvoicePayment = {
        id: this.deps.ids.next(),
        amount: debit.amount,
        method: 'wallet',
        reference: debit.transactionId,
        recordedBy: 'system',
        recordedAt: now,
        idempotencyKey: key,
      };
      const updated = withPayment(invoice, payment);
      let saved = false;
      try {
        saved = await this.deps.invoices.recordPayment(updated, payment, (overdueCount) =>
          updated.status === 'paid' ? [paidEvent(updated, now, overdueCount, 'payment')] : [],
        );
      } catch {
        // Unicité facture + clé : le même crédit vient d'être enregistré par un autre passage.
        saved = false;
      }
      if (saved) return updated.status === 'paid' ? 'paid' : 'partially_paid';
    }
    if (invoice && !isClosed(invoice) && debit.amount <= balance(invoice)) {
      // Modifiée sans cesse en même temps : le message est retraité, même clé, même débit.
      throw new Error(`Facture ${invoice.id} modifiée en même temps ; nouvel essai.`);
    }
    // Soldée entre-temps : le débit est remboursé, l'argent reste au portefeuille.
    await this.deps.wallet.refund({ transactionId: debit.transactionId, reason: 'facture déjà réglée' });
    return 'left_in_wallet';
  }
}

const isClosed = (invoice: Invoice) => invoice.status === 'paid' || invoice.status === 'cancelled';
const hasKey = (invoice: Invoice, key: string) => invoice.payments.some((p) => p.idempotencyKey === key);

function sameHolder(invoice: Invoice, holder: { type: string; id: string }): boolean {
  return invoice.organizationId
    ? holder.type === 'organization' && holder.id === invoice.organizationId
    : holder.type === 'user' && holder.id === invoice.customerId;
}
