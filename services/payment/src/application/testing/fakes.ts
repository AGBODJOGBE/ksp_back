import { createHash, createHmac } from 'node:crypto';
import { type RoleClaim, runWithContext } from '@ksp/platform';
import { type PaymentLink } from '../../domain/payment-link';
import { type Payout, type PayoutBeneficiary, type ProviderPayoutStatus } from '../../domain/payout';
import { type InvoiceDue, type MissionDue } from '../../domain/amount-due';
import {
  DUE_SUBJECT_TYPES,
  type DueSubjectType,
  isUnderReview,
  LATE_SUCCESS_STATUSES,
  type PaymentIntent,
  type ProviderName,
} from '../../domain/payment-intent';
import {
  type AmountDueDirectory,
  type CreatedIntent,
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
  type PeopleDirectory,
  type PaymentProvider,
  type PaymentRepository,
  type ProviderNotification,
  type ProviderNotificationLog,
  type ProviderTransaction,
  type LinkTokens,
  type PaymentLinkRepository,
  type PayoutFilter,
  type PayoutProvider,
  type PayoutRepository,
  type ProviderPayout,
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

  async create(intent: PaymentIntent): Promise<CreatedIntent> {
    const existing = intent.paymentLinkId
      ? await this.findByLinkKey(intent.paymentLinkId, intent.idempotencyKey)
      : await this.findByIdempotencyKey(intent.customerId ?? '', intent.idempotencyKey);
    if (existing) return { created: false, intent: existing, conflict: 'idempotency_key' };
    // Index uniques partiels de la base (ADR-048) : une page en attente par objet dû et par lien.
    const open = [...this.rows.values()].find(
      (r) =>
        r.status === 'pending' &&
        (intent.paymentLinkId
          ? r.paymentLinkId === intent.paymentLinkId
          : DUE_SUBJECT_TYPES.includes(intent.subject.type as DueSubjectType) &&
            r.subject.type === intent.subject.type &&
            r.subject.id === intent.subject.id),
    );
    if (open) return { created: false, intent: { ...open }, conflict: 'open_checkout' };
    this.rows.set(intent.id, { ...intent });
    return { created: true, intent: { ...intent } };
  }
  async findPendingForSubject(input: { subjectType: string; subjectId: string }) {
    const row = [...this.rows.values()]
      .reverse()
      .find(
        (r) =>
          r.subject.type === input.subjectType && r.subject.id === input.subjectId && r.status === 'pending',
      );
    return row ? { ...row } : null;
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByIdempotencyKey(customerId: string, key: string) {
    const row = [...this.rows.values()].find((r) => r.customerId === customerId && r.idempotencyKey === key);
    return row ? { ...row } : null;
  }
  async findByLinkKey(paymentLinkId: string, key: string) {
    const row = [...this.rows.values()].find(
      (r) => r.paymentLinkId === paymentLinkId && r.idempotencyKey === key,
    );
    return row ? { ...row } : null;
  }
  async listForLink(paymentLinkId: string) {
    return [...this.rows.values()]
      .filter((r) => r.paymentLinkId === paymentLinkId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
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
  async listSucceeded(input: { subjectType: string; subjectId: string }) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.subject.type === input.subjectType &&
          r.subject.id === input.subjectId &&
          r.status === 'succeeded',
      )
      .map((r) => ({ id: r.id, succeededAt: r.completedAt ?? r.updatedAt }));
  }
  async listUnresolvedMismatches(input: { subjectType: string; subjectId: string }) {
    return [...this.rows.values()]
      .filter(
        (r) => r.subject.type === input.subjectType && r.subject.id === input.subjectId && isUnderReview(r),
      )
      .map((r) => r.id)
      .sort();
  }
  async listOpenForCustomer(customerId: string) {
    return [...this.rows.values()]
      .filter((r) => r.customerId === customerId && (r.status === 'pending' || isUnderReview(r)))
      .sort((a, b) => a.id.localeCompare(b.id));
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
          (filter.organizationId === undefined || r.organizationId === filter.organizationId) &&
          (filter.underReview === undefined || isUnderReview(r) === filter.underReview),
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

/** Noms d'identity en mémoire ; `down` simule une panne (noms absents, comme l'adaptateur). */
export class InMemoryPeople implements PeopleDirectory {
  readonly users = new Map<string, string>();
  readonly organizations = new Map<string, string>();
  down = false;
  calls = 0;
  async userNames(ids: readonly string[]) {
    this.calls += 1;
    if (this.down) return new Map<string, string>();
    return new Map(ids.filter((id) => this.users.has(id)).map((id) => [id, this.users.get(id)!]));
  }
  async organizationNames(ids: readonly string[]) {
    this.calls += 1;
    if (this.down) return new Map<string, string>();
    return new Map(
      ids.filter((id) => this.organizations.has(id)).map((id) => [id, this.organizations.get(id)!]),
    );
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
      entity: event.name.startsWith('payout.') ? 'payout' : 'transaction',
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
  readonly unrecordedPayments: Parameters<PaymentAlerts['unrecordedPayment']>[0][] = [];
  readonly underReview: Parameters<PaymentAlerts['paymentUnderReview']>[0][] = [];
  amountMismatch(input: Parameters<PaymentAlerts['amountMismatch']>[0]): void {
    this.amountMismatches.push(input);
  }
  transactionMismatch(input: Parameters<PaymentAlerts['transactionMismatch']>[0]): void {
    this.transactionMismatches.push(input);
  }
  unrecordedPayment(input: Parameters<PaymentAlerts['unrecordedPayment']>[0]): void {
    this.unrecordedPayments.push(input);
  }
  paymentUnderReview(input: Parameters<PaymentAlerts['paymentUnderReview']>[0]): void {
    this.underReview.push(input);
  }
  readonly payoutMismatches: Parameters<PaymentAlerts['payoutMismatch']>[0][] = [];
  readonly payoutRejections: Parameters<PaymentAlerts['payoutRejected']>[0][] = [];
  readonly checkoutsClosedUnconfirmed: Parameters<PaymentAlerts['checkoutClosedUnconfirmed']>[0][] = [];
  checkoutClosedUnconfirmed(input: Parameters<PaymentAlerts['checkoutClosedUnconfirmed']>[0]): void {
    this.checkoutsClosedUnconfirmed.push(input);
  }
  readonly payoutStartsUncertain: Parameters<PaymentAlerts['payoutStartUncertain']>[0][] = [];
  payoutRejected(input: Parameters<PaymentAlerts['payoutRejected']>[0]): void {
    this.payoutRejections.push(input);
  }
  payoutStartUncertain(input: Parameters<PaymentAlerts['payoutStartUncertain']>[0]): void {
    this.payoutStartsUncertain.push(input);
  }
  payoutMismatch(input: Parameters<PaymentAlerts['payoutMismatch']>[0]): void {
    this.payoutMismatches.push(input);
  }
}

/** Liens en mémoire (empreinte du jeton à part, comme en base). */
export class InMemoryLinks implements PaymentLinkRepository {
  readonly rows = new Map<string, PaymentLink>();
  readonly hashes = new Map<string, string>();
  async create(link: PaymentLink, tokenHash: string) {
    const existing = await this.findByIssuerKey(link.issuer, link.idempotencyKey);
    if (existing) return { created: false, link: existing };
    this.rows.set(link.id, { ...link });
    this.hashes.set(tokenHash, link.id);
    return { created: true, link: { ...link } };
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByTokenHash(hash: string) {
    const id = this.hashes.get(hash);
    return id ? this.findById(id) : null;
  }
  async findByIssuerKey(issuer: string, key: string) {
    const row = [...this.rows.values()].find((r) => r.issuer === issuer && r.idempotencyKey === key);
    return row ? { ...row } : null;
  }
  async listForSubject(subjectType: string, subjectId: string) {
    return [...this.rows.values()]
      .filter((r) => r.subjectType === subjectType && r.subjectId === subjectId)
      .sort((a, b) => b.id.localeCompare(a.id));
  }
  async save(link: PaymentLink) {
    const current = this.rows.get(link.id);
    if (!current || current.version !== link.version) return false;
    this.rows.set(link.id, { ...link, version: link.version + 1 });
    return true;
  }
}

/** Mêmes jetons que l'adaptateur (HMAC-SHA256, base64url), secret de test. */
export class TestLinkTokens implements LinkTokens {
  issue(linkId: string): string {
    return createHmac('sha256', 'test-secret').update(linkId).digest('base64url');
  }
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

export class InMemoryPayouts implements PayoutRepository {
  readonly rows = new Map<string, Payout>();
  readonly outbox: OutboxMessage[] = [];
  async create(payout: Payout) {
    const existing = await this.findByIssuerKey(payout.issuer, payout.idempotencyKey);
    if (existing) return { created: false, payout: existing };
    this.rows.set(payout.id, { ...payout });
    return { created: true, payout: { ...payout } };
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByIssuerKey(issuer: string, key: string) {
    const row = [...this.rows.values()].find((r) => r.issuer === issuer && r.idempotencyKey === key);
    return row ? { ...row } : null;
  }
  async findByProviderPayoutId(provider: string, providerPayoutId: string) {
    const row = [...this.rows.values()].find(
      (r) => r.provider === provider && r.providerPayoutId === providerPayoutId,
    );
    return row ? { ...row } : null;
  }
  async save(payout: Payout, events: OutboxMessage[]) {
    const current = this.rows.get(payout.id);
    if (!current || current.version !== payout.version) return false;
    this.rows.set(payout.id, { ...payout, version: payout.version + 1 });
    this.outbox.push(...events);
    return true;
  }
  async list(filter: PayoutFilter, page: PageRequest) {
    const items = [...this.rows.values()]
      .filter(
        (r) =>
          (!filter.status || r.status === filter.status) && (!filter.issuer || r.issuer === filter.issuer),
      )
      .sort((a, b) => b.id.localeCompare(a.id))
      .filter((r) => !page.cursor || r.id < page.cursor);
    return {
      items: items.slice(0, page.limit),
      nextCursor: items.length > page.limit ? items[page.limit - 1]!.id : null,
    };
  }
  async listToReconcile(input: { provider: string; checkedBefore: Date; limit: number }) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.provider === input.provider &&
          (r.status === 'requested' ||
            (r.status === 'processing' && (!r.lastCheckedAt || r.lastCheckedAt < input.checkedBefore))),
      )
      .slice(0, input.limit)
      .map((r) => ({ ...r }));
  }
}

/** Prestataire de reversements de test : panne simulable, statut réglable. */
export class FakePayoutProvider {
  readonly name = 'fedapay' as const;
  readonly automatic = true as const;
  readonly payouts = new Map<string, ProviderPayout>();
  readonly started: string[] = [];
  readonly created: { payoutId: string; beneficiary: PayoutBeneficiary }[] = [];
  down = false;
  /** Lancement qui atteint le prestataire mais dont la réponse se perd. */
  loseStartResponse = false;
  /** Refus définitif (HTTP 4xx) à la création ou au lancement. */
  rejectCreate = false;
  rejectStart = false;
  private n = 0;
  async createPayout(request: { payoutId: string; amount: number; beneficiary: PayoutBeneficiary }) {
    if (this.down) throw PaymentErrors.providerUnavailable();
    if (this.rejectCreate) throw PaymentErrors.providerRejected(422);
    this.n += 1;
    const providerPayoutId = String(9000 + this.n);
    this.created.push({ payoutId: request.payoutId, beneficiary: request.beneficiary });
    this.payouts.set(providerPayoutId, {
      providerPayoutId,
      status: 'pending',
      reference: `po_${this.n}`,
      amount: request.amount,
      currency: 'XOF',
    });
    return { providerPayoutId, reference: `po_${this.n}` };
  }
  async startPayout(providerPayoutId: string) {
    if (this.down) throw PaymentErrors.providerUnavailable();
    if (this.rejectStart) throw PaymentErrors.providerRejected(400);
    this.started.push(providerPayoutId);
    this.set(providerPayoutId, { status: 'processing' });
    if (this.loseStartResponse) throw PaymentErrors.providerUnavailable();
  }
  async getPayout(providerPayoutId: string) {
    if (this.down) throw PaymentErrors.providerUnavailable();
    return { ...this.payouts.get(providerPayoutId)! };
  }
  set(providerPayoutId: string, change: Partial<ProviderPayout> & { status?: ProviderPayoutStatus }) {
    this.payouts.set(providerPayoutId, { ...this.payouts.get(providerPayoutId)!, ...change });
  }
}

export const MANUAL_PAYOUT_PROVIDER: PayoutProvider = { name: 'manual', automatic: false };

export function makeDeps(overrides: Partial<PaymentDeps> = {}) {
  const deps = {
    payments: new InMemoryPayments(),
    links: new InMemoryLinks() as PaymentLinkRepository,
    linkTokens: new TestLinkTokens() as LinkTokens,
    payouts: new InMemoryPayouts() as PayoutRepository,
    payoutProvider: MANUAL_PAYOUT_PROVIDER,
    notifications: new InMemoryNotificationLog(),
    dues: new InMemoryDues(),
    people: new InMemoryPeople(),
    provider: new FakeProvider(),
    alerts: new RecordingAlerts(),
    settings: {
      intentTtlMinutes: 30,
      checkoutValidityMinutes: 1440,
      returnUrl: 'https://ksp.bj/mon-espace/paiements',
      recheckAfterSeconds: 10,
      simulationEnabled: false,
      lateSuccessWindowHours: 24,
      lateSuccessRecheckMinutes: 15,
      unrecordedGraceMinutes: 15,
      linkBaseUrl: 'https://ksp.bj/payer',
      linkIssuers: ['recovery'] as readonly string[],
      linkAttemptsPerHour: 10,
      payoutIssuers: ['wallet'] as readonly string[],
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
    recordedPaymentIds: [],
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
    recordedPaymentIds: [],
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
