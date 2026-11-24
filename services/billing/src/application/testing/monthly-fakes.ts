import { type CreditNote, creditNoteYear, formatCreditNoteNumber } from '../../domain/credit-note';
import { formatInvoiceNumber, type Invoice, invoiceYear } from '../../domain/invoice';
import {
  type BillableSession,
  type BillingMonth,
  reminderAt,
  sessionsToInvoice,
} from '../../domain/monthly-invoice';
import { type MonthlyInvoiceRepository, type WalletCredits } from '../monthly/ports';
import { type OutboxMessage } from '../ports';
import { type InMemoryInvoices, type Recorder, type TestWorld, testWorld } from './fakes';

/** Doublure en mémoire du dépôt du lot F, qui partage les factures de `InMemoryInvoices`. */
export class InMemoryMonthly implements MonthlyInvoiceRepository {
  readonly sessions = new Map<string, BillableSession>();
  readonly processed = new Set<string>();
  readonly reminders = new Map<string, Map<number, boolean>>();
  readonly creditNotes: CreditNote[] = [];
  private creditSequence = new Map<number, number>();
  private invoiceSequence = new Map<number, number>();

  constructor(
    private readonly invoices: InMemoryInvoices,
    private readonly recorder: Recorder,
  ) {}

  async recordBillableSession(session: BillableSession, inbox: { eventId: string; consumer: string }) {
    const key = `${inbox.eventId}|${inbox.consumer}`;
    if (this.processed.has(key) || this.sessions.has(session.sessionId)) return 'duplicate' as const;
    this.processed.add(key);
    this.sessions.set(session.sessionId, session);
    return 'recorded' as const;
  }

  async listOrganizationsToInvoice(month: BillingMonth, limit: number) {
    const invoiced = new Set(
      [...this.invoices.invoices.values()]
        .filter((i) => i.kind === 'monthly' && i.periodStart.getTime() === month.start.getTime())
        .map((i) => i.organizationId),
    );
    const ids = [...this.sessions.values()]
      .filter(
        (s) =>
          s.invoiceId === null &&
          s.occurredAt.getTime() < month.end.getTime() &&
          !invoiced.has(s.organizationId),
      )
      .map((s) => s.organizationId);
    return [...new Set(ids)].sort().slice(0, limit);
  }

  async issueMonthly(
    organizationId: string,
    month: BillingMonth,
    draft: (sessions: BillableSession[]) => Omit<Invoice, 'number'> | null,
    events: (invoice: Invoice) => OutboxMessage[],
  ) {
    const exists = [...this.invoices.invoices.values()].some(
      (i) =>
        i.kind === 'monthly' &&
        i.organizationId === organizationId &&
        i.periodStart.getTime() === month.start.getTime(),
    );
    if (exists) return null;
    const pending = sessionsToInvoice(
      [...this.sessions.values()].filter((s) => s.organizationId === organizationId),
      month,
    );
    const built = draft(pending);
    if (!built) return null;
    const year = invoiceYear(built);
    const next = (this.invoiceSequence.get(year) ?? 0) + 1;
    this.invoiceSequence.set(year, next);
    const invoice: Invoice = { ...built, number: formatInvoiceNumber(year, next) };
    this.invoices.invoices.set(invoice.id, invoice);
    for (const session of pending)
      this.sessions.set(session.sessionId, { ...session, invoiceId: invoice.id });
    this.recorder.record(events(invoice));
    return invoice;
  }

  async listPendingPastDue(now: Date, limit: number) {
    return [...this.invoices.invoices.values()]
      .filter((i) => i.kind && i.status === 'pending_payment' && i.dueAt.getTime() < now.getTime())
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, limit);
  }

  async listOpenForReminders(now: Date, offsets: readonly number[], limit: number) {
    const first = Math.min(...offsets);
    return [...this.invoices.invoices.values()]
      .filter(
        (i) =>
          i.kind === 'monthly' &&
          (i.status === 'pending_payment' || i.status === 'overdue') &&
          reminderAt(i.dueAt, first).getTime() <= now.getTime() &&
          (this.reminders.get(i.id)?.size ?? 0) < offsets.length,
      )
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, limit)
      .map((invoice) => ({ invoice, handled: [...(this.reminders.get(invoice.id)?.keys() ?? [])] }));
  }

  async recordReminder(
    invoiceId: string,
    offset: number,
    skipped: readonly number[],
    _at: Date,
    events: OutboxMessage[],
  ) {
    const handled = this.reminders.get(invoiceId) ?? new Map<number, boolean>();
    if (handled.has(offset)) return false;
    for (const value of skipped) if (!handled.has(value)) handled.set(value, false);
    handled.set(offset, true);
    this.reminders.set(invoiceId, handled);
    this.recorder.record(events);
    return true;
  }

  async countOverdueForOrganization(organizationId: string) {
    return [...this.invoices.invoices.values()].filter(
      (i) => i.kind && i.organizationId === organizationId && i.status === 'overdue',
    ).length;
  }

  async findCreditNoteByKey(issuedBy: string, idempotencyKey: string) {
    return (
      this.creditNotes.find((n) => n.issuedBy === issuedBy && n.idempotencyKey === idempotencyKey) ?? null
    );
  }

  async listCreditNotes(invoiceId: string) {
    return this.creditNotes.filter((n) => n.invoiceId === invoiceId);
  }

  async saveCreditNote(
    invoice: Invoice,
    note: Omit<CreditNote, 'number'>,
    events: (note: CreditNote, overdueCount: number) => OutboxMessage[],
  ) {
    const stored = this.invoices.invoices.get(invoice.id);
    if (!stored || stored.version !== invoice.version) return 'conflict' as const;
    const year = creditNoteYear(note.issuedAt);
    const next = (this.creditSequence.get(year) ?? 0) + 1;
    this.creditSequence.set(year, next);
    const saved: CreditNote = { ...note, number: formatCreditNoteNumber(year, next) };
    this.creditNotes.push(saved);
    this.invoices.invoices.set(invoice.id, { ...invoice, version: invoice.version + 1 });
    this.recorder.record(events(saved, this.invoices.countOverdue(invoice)));
    return saved;
  }

  async cancel(
    invoice: Invoice,
    releaseSessions: boolean,
    events: (overdueCount: number) => OutboxMessage[],
  ) {
    const stored = this.invoices.invoices.get(invoice.id);
    if (!stored || stored.version !== invoice.version) return false;
    this.invoices.invoices.set(invoice.id, { ...invoice, version: invoice.version + 1 });
    if (releaseSessions) {
      for (const session of this.sessions.values()) {
        if (session.invoiceId === invoice.id)
          this.sessions.set(session.sessionId, { ...session, invoiceId: null });
      }
    }
    this.recorder.record(events(this.invoices.countOverdue(invoice)));
    return true;
  }
}

/** Crédits au portefeuille simulés, idempotents par clé (wallet.Credit). */
export class FakeWalletCredits implements WalletCredits {
  readonly credits = new Map<string, { transactionId: string; amount: number; holderId: string }>();

  async credit(input: Parameters<WalletCredits['credit']>[0]) {
    const known = this.credits.get(input.idempotencyKey);
    if (known) return { transactionId: known.transactionId };
    const transactionId = `0192f1c4-0000-7000-c000-${String(this.credits.size + 1).padStart(12, '0')}`;
    this.credits.set(input.idempotencyKey, {
      transactionId,
      amount: input.amount,
      holderId: input.holder.id,
    });
    return { transactionId };
  }
}

export interface MonthlyTestWorld extends TestWorld {
  monthly: InMemoryMonthly;
  walletCredits: FakeWalletCredits;
}

export function monthlyTestWorld(): MonthlyTestWorld {
  const world = testWorld();
  return {
    ...world,
    monthly: new InMemoryMonthly(world.invoices, world.recorder),
    walletCredits: new FakeWalletCredits(),
  };
}
