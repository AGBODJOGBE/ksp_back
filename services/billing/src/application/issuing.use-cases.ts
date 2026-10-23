import { duePeriods } from '../domain/contract';
import { dueDate, type Invoice, isOverdue, periodLines } from '../domain/invoice';
import { type BillingDeps } from './ports';

const xof = (amount: number) => ({ amount, currency: 'XOF' as const });

/** Champs communs des événements de facture : identifiants et montant, jamais d'adresse. */
export function invoiceReference(invoice: Invoice) {
  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    customerId: invoice.customerId,
    organizationId: invoice.organizationId,
    source: invoice.source,
    contractId: invoice.contractId,
    total: xof(invoice.total),
  };
}

/**
 * Tâche planifiée : émet les factures des mois terminés (billing.invoice.issued). Idempotente
 * par (contrat, mois) : plusieurs passages ou plusieurs instances n'émettent qu'une facture.
 */
export class IssueDueInvoicesUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(): Promise<{ issued: number }> {
    const now = this.deps.clock.now();
    const { paymentTermDays } = await this.deps.settings.get();
    let issued = 0;
    for (const { contract, invoicedIndexes } of await this.deps.contracts.listOpen()) {
      for (const period of duePeriods(contract, new Set(invoicedIndexes), now)) {
        const draft: Omit<Invoice, 'number'> = {
          id: this.deps.ids.next(),
          status: 'pending_payment',
          contractId: contract.id,
          customerId: contract.customerId,
          organizationId: contract.organizationId,
          source: contract.source,
          periodIndex: period.index,
          periodStart: period.start,
          periodEnd: period.end,
          lines: periodLines(period),
          total: period.amount,
          issuedAt: now,
          dueAt: dueDate(now, paymentTermDays),
          paidAt: null,
          payments: [],
          version: 0,
        };
        const invoice = await this.deps.invoices.issue(draft, (created) => [
          {
            type: 'billing.invoice.issued',
            payload: {
              ...invoiceReference(created),
              periodStart: created.periodStart.toISOString(),
              periodEnd: created.periodEnd.toISOString(),
              issuedAt: created.issuedAt.toISOString(),
              dueAt: created.dueAt.toISOString(),
            },
          },
        ]);
        if (invoice) issued += 1;
      }
    }
    return { issued };
  }
}

/** Tâche planifiée : à l'échéance, « en attente de paiement » devient « impayée » (billing.invoice.overdue). */
export class MarkOverdueInvoicesUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(): Promise<{ overdue: number }> {
    const now = this.deps.clock.now();
    let overdue = 0;
    for (const invoice of await this.deps.invoices.listPastDue(now)) {
      if (!isOverdue(invoice, now)) continue;
      const marked = await this.deps.invoices.markOverdue({ ...invoice, status: 'overdue' }, (count) => [
        {
          type: 'billing.invoice.overdue',
          payload: { ...invoiceReference(invoice), dueAt: invoice.dueAt.toISOString(), overdueCount: count },
        },
      ]);
      if (marked) overdue += 1;
    }
    return { overdue };
  }
}
