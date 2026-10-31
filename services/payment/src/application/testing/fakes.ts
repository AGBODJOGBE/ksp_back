import { type RoleClaim, runWithContext } from '@ksp/platform';
import { type InvoiceDue, type MissionDue } from '../../domain/amount-due';
import { LATE_SUCCESS_STATUSES, type PaymentIntent, type ProviderName } from '../../domain/payment-intent';
import {
  type AmountDueDirectory,
  type Checkout,
  type CheckoutRequest,
  type Clock,
  type IdGenerator,
  type NotificationOutcome,
  type OutboxMessage,
  type PageRequest,
  type PageResult,
  type PaymentAlerts,
  type PaymentDeps,
  type PaymentFilter,
  type PaymentProvider,
  type PaymentRepository,
  type ProviderNotification,
  type ProviderNotificationLog,
  type ProviderTransaction,
} from '../ports';
import { PaymentErrors } from '../shared/errors';

/** Doublures en mémoire des ports, pour les tests des cas d'usage. */
export const CUSTOMER_ID = '0192f1c4-0000-7000-8000-00000000c001';
export const OTHER_CUSTOMER_ID = '0192f1c4-0000-7000-8000-00000000c002';
export const ORGANIZATION_ID = '0192f1c4-0000-7000-8000-00000000a001';
export const MISSION_ID = '0192f1c4-0000-7000-8000-00000000b001';
export const INVOICE_ID = '0192f1c4-0000-7000-8000-00000000f001';
export const STAFF_ID = '0192f1c4-0000-7000-8000-00000000d001';

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-11-02T09:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequenceIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `0192f1c4-0000-7000-8000-${String(this.n).padStart(12, '0')}`;
  }
}

export class InMemoryPayments implements PaymentRepository {
  readonly rows = new Map<string, PaymentIntent>();
  readonly outbox: OutboxMessage[] = [];

  async create(intent: PaymentIntent) {
    const existing = await this.findByIdempotencyKey(intent.customerId, intent.idempotencyKey);
    if (existing) return { created: false, intent: existing };
    this.rows.set(intent.id, { ...intent });
    return { created: true, intent: { ...intent } };
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByIdempotencyKey(customerId: string, key: string) {
    const row = [...this.rows.values()].find((r) => r.customerId === customerId && r.idempotencyKey === key);
    return row ? { ...row } : null;
  }
  async findByTransaction(provider: ProviderName, transactionId: string) {
    const row = [...this.rows.values()].find(
      (r) => r.provider === provider && r.providerTransactionId === transactionId,
    );
    return row ? { ...row } : null;
  }
  async findOpen(input: {
    customerId: string;
    subjectType: string;
    subjectId: string;
    part: string | null;
    now: Date;
  }) {
    const row = [...this.rows.values()]
      .reverse()
      .find(
        (r) =>
          r.customerId === input.customerId &&
          r.subject.type === input.subjectType &&
          r.subject.id === input.subjectId &&
          r.subject.part === input.part &&
          r.status === 'pending' &&
          r.expiresAt > input.now,
      );
    return row ? { ...row } : null;
  }
  async save(intent: PaymentIntent, events: OutboxMessage[]) {
    const current = this.rows.get(intent.id);
    if (!current || current.version !== intent.version) return false;
    this.rows.set(intent.id, { ...intent, version: intent.version + 1 });
    this.outbox.push(...events);
    return true;
  }
  async list(filter: PaymentFilter, page: PageRequest): Promise<PageResult<PaymentIntent>> {
    const items = [...this.rows.values()]
      .filter(
        (r) =>
          (!filter.status || r.status === filter.status) &&
          (!filter.subjectType || r.subject.type === filter.subjectType) &&
          (!filter.subjectId || r.subject.id === filter.subjectId) &&
          (!filter.customerId || r.customerId === filter.customerId) &&
          (filter.organizationId === undefined || r.organizationId === filter.organizationId),
      )
      .sort((a, b) => b.id.localeCompare(a.id))
      .filter((r) => !page.cursor || r.id < page.cursor);
    return {
      items: items.slice(0, page.limit),
      nextCursor: items.length > page.limit ? items[page.limit - 1]!.id : null,
    };
  }
  async listPendingToReconcile(input: { checkedBefore: Date; createdBefore: Date; limit: number }) {
    return this.byLastCheck(
      (r) =>
        r.status === 'pending' &&
        r.createdAt < input.createdBefore &&
        (!r.lastCheckedAt || r.lastCheckedAt < input.checkedBefore),
      input.limit,
    );
  }
  async listClosedToReconcile(input: { checkedBefore: Date; lateSince: Date; limit: number }) {
    return this.byLastCheck(
      (r) =>
        LATE_SUCCESS_STATUSES.includes(r.status) &&
        r.providerTransactionId !== null &&
        r.completedAt !== null &&
        r.completedAt >= input.lateSince &&
        (!r.lastCheckedAt || r.lastCheckedAt < input.checkedBefore),
      input.limit,
    );
  }
  /** Jamais relus d'abord, puis les plus anciennement relus. */
  private byLastCheck(keep: (r: PaymentIntent) => boolean, limit: number) {
    const time = (r: PaymentIntent) => (r.lastCheckedAt ? r.lastCheckedAt.getTime() : -Infinity);
    return [...this.rows.values()]
      .filter(keep)
      .sort((a, b) => time(a) - time(b) || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

export class InMemoryNotificationLog implements ProviderNotificationLog {
  readonly entries: { outcome: NotificationOutcome; eventName: string; paymentId: string | null }[] = [];
  async record(entry: { outcome: NotificationOutcome; eventName: string; paymentId: string | null }) {
    this.entries.push({ outcome: entry.outcome, eventName: entry.eventName, paymentId: entry.paymentId });
  }
}

export class InMemoryDues implements AmountDueDirectory {
  readonly missions = new Map<string, MissionDue>();
  readonly invoices = new Map<string, InvoiceDue>();
  calls = 0;
  async missionDue(id: string) {
    this.calls += 1;
    return this.missions.get(id) ?? null;
  }
  async invoiceDue(id: string) {
    this.calls += 1;
    return this.invoices.get(id) ?? null;
  }
}

/** Prestataire de test : transactions en mémoire, panne simulable, notifications « signées » par un jeton. */
export class FakeProvider implements PaymentProvider {
  readonly name = 'fedapay' as const;
  readonly transactions = new Map<string, ProviderTransaction>();
  readonly checkouts: CheckoutRequest[] = [];
  down = false;
  private n = 0;

  async createCheckout(request: CheckoutRequest): Promise<Checkout> {
    if (this.down) throw PaymentErrors.providerUnavailable();
    this.checkouts.push(request);
    this.n += 1;
    const transactionId = String(1000 + this.n);
    this.transactions.set(transactionId, {
      transactionId,
      paymentId: request.paymentId,
      reference: `trx_${this.n}`,
      status: 'pending',
      amount: request.amount,
      currency: 'XOF',
    });
    return {
      transactionId,
      reference: `trx_${this.n}`,
      checkoutUrl: `https://process.fedapay.com/tok${this.n}`,
    };
  }
  async getTransaction(transactionId: string): Promise<ProviderTransaction> {
    if (this.down) throw PaymentErrors.providerUnavailable();
    const transaction = this.transactions.get(transactionId);
    if (!transaction) throw PaymentErrors.providerUnavailable();
    return { ...transaction };
  }
  verifyNotification(payload: Uint8Array, signature: string): ProviderNotification {
    if (signature !== 'valid') throw PaymentErrors.signatureInvalid();
    const event = JSON.parse(Buffer.from(payload).toString('utf8')) as {
      name: string;
      entity?: { id?: number };
    };
    return {
      eventName: event.name,
      eventId: null,
      transactionId: event.entity?.id ? String(event.entity.id) : null,
    };
  }
  readonly cancelled: string[] = [];
  async cancelTransaction(transactionId: string): Promise<boolean> {
    const transaction = this.transactions.get(transactionId);
    if (!transaction || transaction.status !== 'pending') return false;
    this.cancelled.push(transactionId);
    this.transactions.set(transactionId, { ...transaction, status: 'canceled' });
    return true;
  }
  /** Change le statut chez le prestataire (le client a payé, refusé…). */
  set(transactionId: string, change: Partial<ProviderTransaction>): void {
    this.transactions.set(transactionId, { ...this.transactions.get(transactionId)!, ...change });
  }
}

export class RecordingAlerts implements PaymentAlerts {
  readonly amountMismatches: Parameters<PaymentAlerts['amountMismatch']>[0][] = [];
  readonly transactionMismatches: Parameters<PaymentAlerts['transactionMismatch']>[0][] = [];
  amountMismatch(input: Parameters<PaymentAlerts['amountMismatch']>[0]): void {
    this.amountMismatches.push(input);
  }
  transactionMismatch(input: Parameters<PaymentAlerts['transactionMismatch']>[0]): void {
    this.transactionMismatches.push(input);
  }
}

export function makeDeps(overrides: Partial<PaymentDeps> = {}) {
  const deps = {
    payments: new InMemoryPayments(),
    notifications: new InMemoryNotificationLog(),
    dues: new InMemoryDues(),
    provider: new FakeProvider(),
    alerts: new RecordingAlerts(),
    settings: {
      intentTtlMinutes: 30,
      returnUrl: 'https://ksp.bj/mon-espace/paiements',
      recheckAfterSeconds: 10,
      simulationEnabled: false,
      lateSuccessWindowHours: 24,
      lateSuccessRecheckMinutes: 15,
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    ...overrides,
  };
  return deps;
}

export function missionDue(overrides: Partial<MissionDue> = {}): MissionDue {
  return {
    missionId: MISSION_ID,
    customerId: CUSTOMER_ID,
    organizationId: null,
    status: 'scheduled',
    depositDue: 15000,
    remainingDue: 50000,
    ...overrides,
  };
}

export function invoiceDue(overrides: Partial<InvoiceDue> = {}): InvoiceDue {
  return {
    invoiceId: INVOICE_ID,
    number: 'FAC-2026-000042',
    customerId: CUSTOMER_ID,
    organizationId: ORGANIZATION_ID,
    status: 'pending_payment',
    balance: 160000,
    ...overrides,
  };
}

function as<T>(
  userId: string,
  fn: () => Promise<T>,
  options: { roles?: string[]; mfa?: boolean; activeContext?: string } = {},
): Promise<T> {
  const roles: RoleClaim[] = (options.roles ?? ['customer']).map((role) => ({ role, scopeType: 'global' }));
  return runWithContext(
    {
      correlationId: 'c-test',
      user: {
        userId,
        sessionId: 's-test',
        activeContext: options.activeContext ?? 'personal',
        roles,
        mfa: options.mfa ?? false,
        authTime: Math.floor(Date.now() / 1000),
      },
    },
    fn,
  );
}

/** Exécute en tant que client (contexte personnel, ou organisation active). */
export function asCustomer<T>(
  fn: () => Promise<T>,
  userId = CUSTOMER_ID,
  organizationId?: string,
): Promise<T> {
  return as(userId, fn, organizationId ? { activeContext: organizationId } : {});
}

export function asStaff<T>(fn: () => Promise<T>, role = 'finance_officer', mfa = true): Promise<T> {
  return as(STAFF_ID, fn, { roles: [role], mfa });
}

/** Appel d'un autre service (jeton de service vérifié par le kit). */
export function asService<T>(service: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ correlationId: 'c-test', callerService: service }, fn);
}
