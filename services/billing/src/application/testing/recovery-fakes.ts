import {
  type CommissionCollection,
  type CommissionInvoice,
  commissionInvoiceYear,
  type CreditorRef,
  formatCommissionInvoiceNumber,
} from '../../domain/commission-invoice';
import { type FeeReceipt, formatFeeReceiptNumber } from '../../domain/fee-receipt';
import { type BillingMonth } from '../../domain/monthly-invoice';
import { type OutboxMessage, type PageRequest } from '../ports';
import {
  type CommissionInvoiceFilter,
  type FeeReceiptFilter,
  type RecoveryBillingDeps,
  type RecoveryBillingRepository,
} from '../recovery/ports';
import {
  FakeWallet,
  FixedClock,
  InMemoryOrganizations,
  ORGANIZATION_ID,
  ORGANIZATION_PROFILE,
  Recorder,
  SequentialIds,
} from './fakes';

/** Doublure en mémoire du dépôt du recouvrement (ADR-064) : mêmes règles d'idempotence que la base. */
const same = (a: CreditorRef, b: CreditorRef) => a.type === b.type && a.id === b.id;

function page<T extends { id: string }>(items: T[], request: PageRequest) {
  const sorted = [...items].sort((a, b) => b.id.localeCompare(a.id));
  const from = request.cursor ? sorted.filter((item) => item.id < request.cursor!) : sorted;
  const slice = from.slice(0, request.limit);
  return { items: slice, nextCursor: from.length > request.limit ? slice.at(-1)!.id : null };
}

export class InMemoryRecoveryBilling implements RecoveryBillingRepository {
  readonly collections = new Map<string, CommissionCollection>();
  readonly invoices = new Map<string, CommissionInvoice>();
  readonly receipts = new Map<string, FeeReceipt>();
  readonly processed = new Set<string>();
  readonly counters = new Map<string, number>();

  constructor(private readonly recorder: Recorder) {}

  private next(series: string, year: number): number {
    const value = (this.counters.get(`${series}:${year}`) ?? 0) + 1;
    this.counters.set(`${series}:${year}`, value);
    return value;
  }

  private mark(inbox: { eventId: string; consumer: string }): boolean {
    const key = `${inbox.eventId}:${inbox.consumer}`;
    if (this.processed.has(key)) return false;
    this.processed.add(key);
    return true;
  }

  async recordCollection(collection: CommissionCollection, inbox: { eventId: string; consumer: string }) {
    if (!this.mark(inbox) || this.collections.has(collection.collectionId)) return 'duplicate' as const;
    this.collections.set(collection.collectionId, collection);
    return 'recorded' as const;
  }

  async listCreditorsToInvoice(month: BillingMonth, limit: number) {
    const creditors = new Map<string, CreditorRef>();
    for (const collection of this.collections.values()) {
      if (collection.invoiceId !== null || collection.receivedAt >= month.end) continue;
      const invoiced = [...this.invoices.values()].some(
        (invoice) =>
          same(invoice.creditor, collection.creditor) &&
          invoice.periodStart.getTime() === month.start.getTime(),
      );
      if (!invoiced)
        creditors.set(`${collection.creditor.type}:${collection.creditor.id}`, collection.creditor);
    }
    return [...creditors.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([, creditor]) => creditor);
  }

  async issueCommissionInvoice(
    creditor: CreditorRef,
    month: BillingMonth,
    draft: (collections: CommissionCollection[]) => Omit<CommissionInvoice, 'number'> | null,
    events: (invoice: CommissionInvoice) => OutboxMessage[],
  ) {
    const exists = [...this.invoices.values()].some(
      (invoice) =>
        same(invoice.creditor, creditor) && invoice.periodStart.getTime() === month.start.getTime(),
    );
    if (exists) return null;
    const built = draft(
      [...this.collections.values()].filter(
        (collection) =>
          same(collection.creditor, creditor) &&
          collection.invoiceId === null &&
          collection.receivedAt < month.end,
      ),
    );
    if (!built) return null;
    const year = commissionInvoiceYear(built);
    const invoice = { ...built, number: formatCommissionInvoiceNumber(year, this.next('FCR', year)) };
    this.invoices.set(invoice.id, invoice);
    for (const line of invoice.lines) {
      const collection = this.collections.get(line.collectionId)!;
      this.collections.set(line.collectionId, { ...collection, invoiceId: invoice.id });
    }
    this.recorder.record(events(invoice));
    return invoice;
  }

  async listDueDebits(now: Date, limit: number) {
    return [...this.invoices.values()]
      .filter(
        (invoice) =>
          invoice.status === 'pending_payment' &&
          invoice.debit.nextAttemptAt !== null &&
          invoice.debit.nextAttemptAt <= now,
      )
      .sort((a, b) => a.debit.nextAttemptAt!.getTime() - b.debit.nextAttemptAt!.getTime())
      .slice(0, limit);
  }

  async saveDebit(invoice: CommissionInvoice) {
    const stored = this.invoices.get(invoice.id);
    if (!stored || stored.version !== invoice.version || stored.status !== 'pending_payment') return false;
    this.invoices.set(invoice.id, { ...invoice, version: invoice.version + 1 });
    return true;
  }

  async findCommissionInvoice(id: string) {
    return this.invoices.get(id) ?? null;
  }

  async listCommissionInvoices(filter: CommissionInvoiceFilter, request: PageRequest) {
    return page(
      [...this.invoices.values()].filter(
        (invoice) =>
          (!filter.creditor || same(invoice.creditor, filter.creditor)) &&
          (!filter.creditorId || invoice.creditor.id === filter.creditorId) &&
          (!filter.status || invoice.status === filter.status) &&
          (!filter.periodStart || invoice.periodStart.getTime() === filter.periodStart.getTime()),
      ),
      request,
    );
  }

  async listUnpaidForCreditors(creditors: readonly CreditorRef[]) {
    return [...this.invoices.values()]
      .filter(
        (invoice) =>
          invoice.status === 'pending_payment' &&
          creditors.some((creditor) => same(creditor, invoice.creditor)),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async recordFeeReceipt(
    receipt: Omit<FeeReceipt, 'number'>,
    year: number,
    inbox: { eventId: string; consumer: string },
  ) {
    if (!this.mark(inbox)) return 'duplicate' as const;
    const known = [...this.receipts.values()].some(
      (each) => each.walletTransactionId === receipt.walletTransactionId,
    );
    if (known) return 'duplicate' as const;
    this.receipts.set(receipt.id, {
      ...receipt,
      number: formatFeeReceiptNumber(year, this.next('RFD', year)),
    });
    return 'recorded' as const;
  }

  async listFeeReceipts(filter: FeeReceiptFilter, request: PageRequest) {
    return page(
      [...this.receipts.values()].filter(
        (receipt) =>
          same(receipt.payer, filter.payer) && (!filter.caseId || receipt.caseId === filter.caseId),
      ),
      request,
    );
  }
}

export interface RecoveryTestWorld extends RecoveryBillingDeps {
  recorder: Recorder;
  recovery: InMemoryRecoveryBilling;
  organizations: InMemoryOrganizations;
  wallet: FakeWallet;
  clock: FixedClock;
}

export function recoveryTestWorld(): RecoveryTestWorld {
  const recorder = new Recorder();
  const organizations = new InMemoryOrganizations();
  organizations.profiles.set(ORGANIZATION_ID, ORGANIZATION_PROFILE);
  return {
    recorder,
    recovery: new InMemoryRecoveryBilling(recorder),
    organizations,
    wallet: new FakeWallet(),
    clock: new FixedClock(),
    ids: new SequentialIds(),
  };
}
