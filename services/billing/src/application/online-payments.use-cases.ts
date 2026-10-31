import { currentContext } from '@ksp/platform';
import { balance, type Invoice, type InvoicePayment, paidAmount, withOnlinePayment } from '../domain/invoice';
import { invoiceReference } from './issuing.use-cases';
import { type BillingDeps } from './ports';
import { BillingErrors } from './shared/errors';
import { requireUuid } from './shared/validation';

/** Seul payment lit le reste dû d'une facture (ADR-031). */
const PAYMENT_CALLERS = new Set(['payment']);
/** Consommateur des événements de payment : file `billing.<événement>`. */
export const PAYMENT_CONSUMER = 'billing';
/** Auteur des paiements en ligne : le système, pas un membre de l'équipe. */
export const SYSTEM_ACTOR = 'system';
const MAX_ATTEMPTS = 3;

/**
 * InvoicePaymentDueService.GetInvoiceAmountDue : reste dû d'une facture, tel que billing le calcule.
 * payment vérifie lui-même que le payeur est le client ou un membre de l'organisation facturée.
 */
export class GetInvoiceAmountDueUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(invoiceId: string): Promise<{ invoice: Invoice; paid: number; balance: number }> {
    // Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur (développement).
    const caller = currentContext()?.callerService;
    if (caller && !PAYMENT_CALLERS.has(caller)) throw BillingErrors.callerForbidden();
    const invoice = await this.deps.invoices.findById(requireUuid('invoiceId', invoiceId));
    if (!invoice) throw BillingErrors.invoiceNotFound();
    return { invoice, paid: paidAmount(invoice), balance: balance(invoice) };
  }
}

export type OnlinePaymentOutcome = 'recorded' | 'duplicate' | 'ignored';

/** Issue, et excédent éventuel (au-delà du reste dû, à rembourser : différé, ADR-031). */
export interface OnlinePaymentResult {
  outcome: OnlinePaymentOutcome;
  excess: number;
}

/**
 * payment.intent.succeeded : paiement en ligne d'une facture, confirmé par le prestataire. Il est
 * enregistré (moyen `mobile_money_online`, auteur `system`) avec l'inbox dans la même transaction :
 * un événement reçu deux fois n'a qu'un effet. Au total, la facture devient payée
 * (billing.invoice.paid), ce qui lève la suspension du contrat s'il le faut (règles en place).
 * Sur une facture déjà payée ou annulée, l'argent reçu est enregistré sans changer son état.
 */
export class RecordOnlineInvoicePaymentUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(input: {
    eventId: string;
    eventType: string;
    paymentId: string;
    subjectType: string;
    invoiceId: string;
    amount: number;
    providerReference: string | null;
    succeededAt: string;
  }): Promise<OnlinePaymentResult> {
    const ignored = { outcome: 'ignored' as const, excess: 0 };
    if (input.subjectType !== 'billing_invoice') return ignored;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const invoice = await this.deps.invoices.findById(input.invoiceId);
      if (!invoice) return ignored;
      // Même paiement déjà enregistré (identifiant du paiement de payment) : rien de plus.
      if (invoice.payments.some((payment) => payment.id === input.paymentId)) {
        return { outcome: 'duplicate', excess: 0 };
      }
      const now = this.deps.clock.now();
      const succeededAt = new Date(input.succeededAt);
      const payment: InvoicePayment = {
        id: input.paymentId,
        amount: input.amount,
        method: 'mobile_money_online',
        reference: input.providerReference ? input.providerReference.slice(0, 100) : null,
        recordedBy: SYSTEM_ACTOR,
        recordedAt: Number.isNaN(succeededAt.getTime()) ? now : succeededAt,
      };
      const updated = withOnlinePayment(invoice, payment);
      // Facture déjà payée ou annulée : tout le paiement est en trop ; sinon, ce qui dépasse le reste dû.
      const excess =
        invoice.status === 'paid' || invoice.status === 'cancelled'
          ? input.amount
          : Math.max(0, input.amount - balance(invoice));
      const becamePaid = invoice.status !== 'paid' && updated.status === 'paid';
      const result = await this.deps.invoices.recordOnlinePayment(
        updated,
        payment,
        { eventId: input.eventId, consumer: `${PAYMENT_CONSUMER}.${input.eventType}` },
        (overdueCount) =>
          becamePaid
            ? [
                {
                  type: 'billing.invoice.paid',
                  payload: {
                    ...invoiceReference(updated),
                    paidAt: (updated.paidAt ?? now).toISOString(),
                    overdueCount,
                  },
                },
              ]
            : [],
      );
      if (result === 'saved') return { outcome: 'recorded', excess };
      if (result === 'duplicate') return { outcome: 'duplicate', excess: 0 };
    }
    throw BillingErrors.concurrentUpdate();
  }
}
