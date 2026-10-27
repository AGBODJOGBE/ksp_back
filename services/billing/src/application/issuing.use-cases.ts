import { duePeriods } from '../domain/contract';
import { dueDate, type Invoice, type InvoiceOrganization, isOverdue, periodLines } from '../domain/invoice';
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
 *
 * La facture d'une organisation porte son en-tête (raison sociale, adresse, IFU, RCCM), lu dans
 * identity au moment de l'émission. Elle n'est jamais émise sans : identity indisponible → erreur,
 * aucune facture n'est émise et le passage suivant réessaie ; organisation introuvable → le contrat
 * est reporté (`deferredContractIds`), les autres sont facturés.
 */
export class IssueDueInvoicesUseCase {
  constructor(private readonly deps: BillingDeps) {}

  async execute(): Promise<{ issued: number; deferredContractIds: string[] }> {
    const now = this.deps.clock.now();
    const due = (await this.deps.contracts.listOpen())
      .map(({ contract, invoicedIndexes }) => ({
        contract,
        periods: duePeriods(contract, new Set(invoicedIndexes), now),
      }))
      .filter(({ periods }) => periods.length > 0);
    if (due.length === 0) return { issued: 0, deferredContractIds: [] };

    const headers = await this.organizationHeaders(due.map(({ contract }) => contract.organizationId));
    const { paymentTermDays } = await this.deps.settings.get();
    let issued = 0;
    const deferredContractIds: string[] = [];
    for (const { contract, periods } of due) {
      const organization = contract.organizationId
        ? (headers.get(contract.organizationId.toLowerCase()) ?? null)
        : null;
      if (contract.organizationId && !organization) {
        deferredContractIds.push(contract.id);
        continue;
      }
      for (const period of periods) {
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
          organization,
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
    return { issued, deferredContractIds };
  }

  /** En-têtes des organisations à facturer, lus dans identity, par identifiant en minuscules. */
  private async organizationHeaders(
    organizationIds: readonly (string | null)[],
  ): Promise<Map<string, InvoiceOrganization>> {
    const ids = [...new Set(organizationIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const profiles = await this.deps.organizations.findByIds(ids);
    return new Map(
      profiles.map(({ id, legalName, address, ifu, rccm }) => [
        id.toLowerCase(),
        { legalName, address, ifu, rccm },
      ]),
    );
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
