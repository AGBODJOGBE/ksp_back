import { createHmac } from 'node:crypto';
import { AppError, type RoleClaim, runWithContext } from '@ksp/platform';
import {
  type AccountCode,
  accountOf,
  balanceDelta,
  type Holder,
  holderAccount,
  INTERNAL_ACCOUNTS,
  isBalanced,
  type LedgerTransaction,
  prepaidAccount,
  type StatementAccount,
} from '../../domain/ledger';
import { type WalletPayout } from '../../domain/wallet-payout';
import {
  type Clock,
  type IdGenerator,
  type LedgerOverview,
  type LedgerStore,
  type PageRequest,
  type PageResult,
  type PayoutExecutor,
  type PayoutFilter,
  type PrepaidSummary,
  type RecordOutcome,
  type StatementLine,
  type TopUpPayment,
  type TopUpPayments,
  type TopUpRecord,
  type ManualCreditRequest,
  type ManualCreditRequests,
  type ManualCreditStatus,
  type WalletDeps,
  type WalletOutboxMessage,
  type WalletPayoutRepository,
  type WalletSummary,
} from '../ports';

export const USER_ID = '0192f1c4-0000-7000-8000-00000000c001';
export const ORGANIZATION_ID = '0192f1c4-0000-7000-8000-00000000a001';
export const STAFF_ID = '0192f1c4-0000-7000-8000-00000000d001';

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-11-07T09:00:00.000Z')) {}
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

interface Entry {
  id: string;
  transactionId: string;
  account: AccountCode;
  direction: 'debit' | 'credit';
  amount: number;
  balanceAfter: number;
}

/**
 * Grand livre et reversements en mémoire, avec la même atomicité que la base : tout ou rien, soldes
 * tenus par les écritures, références uniques par appelant, une seule annulation par transaction.
 */
export class InMemoryWallet implements LedgerStore, WalletPayoutRepository {
  readonly transactions = new Map<string, LedgerTransaction>();
  readonly entries: Entry[] = [];
  readonly balances = new Map<AccountCode, number>();
  readonly payoutRows = new Map<string, WalletPayout>();
  readonly inbox = new Set<string>();
  /** Événements écrits avec les écritures (outbox). */
  readonly events: WalletOutboxMessage[] = [];
  private n = 0;

  async record(input: Parameters<LedgerStore['record']>[0]): Promise<RecordOutcome> {
    const tx = input.transaction;
    if (!isBalanced(tx.entries)) throw new Error('transaction déséquilibrée');
    if (input.inbox && this.inbox.has(`${input.inbox.eventId}:${input.inbox.consumer}`)) {
      return { kind: 'already_processed' };
    }
    const duplicate =
      [...this.transactions.values()].some(
        (t) =>
          (t.caller === tx.caller && t.reference === tx.reference) ||
          (tx.reversesTransactionId !== null && t.reversesTransactionId === tx.reversesTransactionId),
      ) ||
      (input.createPayout !== undefined &&
        [...this.payoutRows.values()].some(
          (p) =>
            p.caller === input.createPayout!.caller &&
            p.idempotencyKey === input.createPayout!.idempotencyKey,
        ));
    if (duplicate) return { kind: 'duplicate' };
    const holderCode = accountOf(tx);
    const balance = this.balances.get(holderCode) ?? 0;
    if (input.requireHolderBalance !== undefined && balance < input.requireHolderBalance) {
      return { kind: 'insufficient', balance };
    }
    if (input.updatePayout) {
      const current = this.payoutRows.get(input.updatePayout.id);
      if (!current || current.version !== input.updatePayout.version) return { kind: 'conflict' };
      this.payoutRows.set(input.updatePayout.id, { ...input.updatePayout, version: current.version + 1 });
    }
    if (input.createPayout) this.payoutRows.set(input.createPayout.id, { ...input.createPayout });
    this.transactions.set(tx.id, tx);
    for (const line of tx.entries) {
      const next = (this.balances.get(line.account) ?? 0) + balanceDelta(line);
      this.balances.set(line.account, next);
      this.n += 1;
      this.entries.push({
        id: `0192f1c4-0000-7000-9000-${String(this.n).padStart(12, '0')}`,
        transactionId: tx.id,
        account: line.account,
        direction: line.direction,
        amount: line.amount,
        balanceAfter: next,
      });
    }
    if (input.inbox) this.inbox.add(`${input.inbox.eventId}:${input.inbox.consumer}`);
    const holderBalance = this.balances.get(holderCode) ?? 0;
    this.events.push(...(input.events?.(holderBalance) ?? []));
    return { kind: 'recorded', transaction: tx, holderBalance };
  }

  async findTransaction(id: string) {
    return this.transactions.get(id) ?? null;
  }
  async findByReference(caller: string, reference: string) {
    return (
      [...this.transactions.values()].find((t) => t.caller === caller && t.reference === reference) ?? null
    );
  }
  async findReversalOf(id: string) {
    return [...this.transactions.values()].find((t) => t.reversesTransactionId === id) ?? null;
  }
  async summary(holder: Holder): Promise<WalletSummary> {
    const of = (t: LedgerTransaction) => t.holder.type === holder.type && t.holder.id === holder.id;
    const txs = [...this.transactions.values()].filter(of);
    const payouts = [...this.payoutRows.values()].filter(
      (p) => p.holder.type === holder.type && p.holder.id === holder.id,
    );
    const code = holderAccount(holder);
    const last = this.entries.filter((e) => e.account === code).at(-1);
    return {
      holder,
      balance: this.balances.get(code) ?? 0,
      payoutsInProgress: payouts
        .filter((p) => p.status === 'pending_submission' || p.status === 'submitted')
        .reduce((sum, p) => sum + p.amount, 0),
      totalCollected:
        txs.filter((t) => t.kind === 'collection').reduce((sum, t) => sum + t.amount, 0) -
        txs.filter((t) => t.kind === 'reversal').reduce((sum, t) => sum + t.amount, 0),
      totalPaidOut: payouts.filter((p) => p.status === 'completed').reduce((sum, p) => sum + p.amount, 0),
      lastEntryAt: last ? this.transactions.get(last.transactionId)!.createdAt : null,
      prepaid: await this.prepaidSummary(holder),
    };
  }
  async prepaidSummary(holder: Holder): Promise<PrepaidSummary> {
    const code = prepaidAccount(holder);
    const last = this.entries.filter((e) => e.account === code).at(-1);
    return {
      holder,
      balance: this.balances.get(code) ?? 0,
      lastEntryAt: last ? this.transactions.get(last.transactionId)!.createdAt : null,
    };
  }
  async statement(
    holder: Holder,
    accounts: readonly StatementAccount[],
    page: PageRequest,
  ): Promise<PageResult<StatementLine>> {
    const codes = new Map<string, StatementAccount>(
      accounts.map((a) => [a === 'prepaid' ? prepaidAccount(holder) : holderAccount(holder), a]),
    );
    const lines = this.entries
      .filter((e) => codes.has(e.account))
      .reverse()
      .filter((e) => !page.cursor || e.id < page.cursor)
      .map((e) => {
        const transaction = this.transactions.get(e.transactionId)!;
        const payout = transaction.payoutId ? this.payoutRows.get(transaction.payoutId) : undefined;
        return {
          entryId: e.id,
          account: codes.get(e.account)!,
          transaction,
          direction: e.direction,
          amount: e.amount,
          balanceAfter: e.balanceAfter,
          payoutStatus: payout?.status ?? null,
        };
      });
    return {
      items: lines.slice(0, page.limit),
      nextCursor: lines.length > page.limit ? lines[page.limit - 1]!.entryId : null,
    };
  }
  async overview(): Promise<LedgerOverview> {
    const of = (prefix: string) => [...this.balances.entries()].filter(([code]) => code.startsWith(prefix));
    const holders = of('holder:');
    const customers = of('prepaid:');
    return {
      internal: INTERNAL_ACCOUNTS.map((account) => ({ account, balance: this.balances.get(account) ?? 0 })),
      owedToHolders: holders.reduce((sum, [, balance]) => sum + balance, 0),
      holdersCount: holders.length,
      owedToCustomers: customers.reduce((sum, [, balance]) => sum + balance, 0),
      customersCount: customers.length,
    };
  }

  // --- Reversements -------------------------------------------------------------------------------
  async findById(id: string) {
    const row = this.payoutRows.get(id);
    return row ? { ...row } : null;
  }
  async findByKey(caller: string, key: string) {
    const row = [...this.payoutRows.values()].find((p) => p.caller === caller && p.idempotencyKey === key);
    return row ? { ...row } : null;
  }
  async save(payout: WalletPayout) {
    const current = this.payoutRows.get(payout.id);
    if (!current || current.version !== payout.version) return false;
    this.payoutRows.set(payout.id, { ...payout, version: payout.version + 1 });
    return true;
  }
  async list(filter: PayoutFilter, page: PageRequest) {
    const items = [...this.payoutRows.values()]
      .filter(
        (p) =>
          (!filter.status || p.status === filter.status) &&
          (!filter.holder || (p.holder.type === filter.holder.type && p.holder.id === filter.holder.id)),
      )
      .sort((a, b) => b.id.localeCompare(a.id))
      .filter((p) => !page.cursor || p.id < page.cursor);
    return {
      items: items.slice(0, page.limit),
      nextCursor: items.length > page.limit ? items[page.limit - 1]!.id : null,
    };
  }
  async listPendingSubmission(limit: number) {
    return [...this.payoutRows.values()].filter((p) => p.status === 'pending_submission').slice(0, limit);
  }
}

/** payment simulé : reversements reçus, panne simulable. */
export class FakeExecutor implements PayoutExecutor {
  readonly requests: Parameters<PayoutExecutor['request']>[0][] = [];
  down = false;
  async request(input: Parameters<PayoutExecutor['request']>[0]) {
    if (this.down) throw AppError.unavailable('GRPC_UNAVAILABLE', 'payment injoignable');
    this.requests.push(input);
    return { payoutId: `0192f1c4-0000-7000-a000-${String(this.requests.length).padStart(12, '0')}` };
  }
}

/** payment simulé : recharges créées (une par clé), relues (paiements connus), panne simulable. */
export class FakeTopUps implements TopUpPayments {
  readonly requests: { idempotencyKey: string; amount: number }[] = [];
  /** Paiements de recharge connus de payment, par identifiant. */
  readonly records = new Map<string, TopUpRecord>();
  down = false;
  async get(paymentId: string): Promise<TopUpRecord | null> {
    if (this.down) throw AppError.unavailable('GRPC_UNAVAILABLE', 'payment injoignable');
    return this.records.get(paymentId) ?? null;
  }
  /** Recharge réussie (ou autre statut) du titulaire, telle que payment la rend. */
  record(paymentId: string, holderId: string, amount: number, overrides: Partial<TopUpRecord> = {}) {
    this.records.set(paymentId, {
      paymentId,
      status: 'succeeded',
      holderId,
      customerId: holderId,
      organizationId: null,
      amount,
      receivedAmount: amount,
      ...overrides,
    });
  }
  async create(input: { idempotencyKey: string; amount: number }): Promise<TopUpPayment> {
    if (this.down) throw AppError.unavailable('PAYMENT_PROVIDER_UNAVAILABLE', 'prestataire injoignable');
    const known = this.requests.findIndex((r) => r.idempotencyKey === input.idempotencyKey);
    if (known < 0) this.requests.push(input);
    const n = (known < 0 ? this.requests.length : known + 1).toString().padStart(12, '0');
    return {
      paymentId: `0192f1c4-0000-7000-b000-${n}`,
      amount: input.amount,
      status: 'pending',
      checkoutUrl: `https://pay.example/${n}`,
      expiresAt: new Date('2026-11-07T09:30:00.000Z'),
      created: known < 0,
    };
  }
}

/** Demandes de crédit manuel en mémoire (clé unique, contrôle de version). */
export class InMemoryCreditRequests implements ManualCreditRequests {
  readonly rows = new Map<string, ManualCreditRequest>();
  async create(request: ManualCreditRequest) {
    const existing = await this.findByKey(request.idempotencyKey);
    if (existing) return { created: false, request: existing };
    this.rows.set(request.id, { ...request });
    return { created: true, request: { ...request } };
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findByKey(key: string) {
    const row = [...this.rows.values()].find((r) => r.idempotencyKey === key);
    return row ? { ...row } : null;
  }
  async save(request: ManualCreditRequest) {
    const current = this.rows.get(request.id);
    if (!current || current.version !== request.version) return false;
    this.rows.set(request.id, { ...request, version: request.version + 1 });
    return true;
  }
  async list(filter: { status?: ManualCreditStatus }, page: PageRequest) {
    const items = [...this.rows.values()]
      .filter((r) => !filter.status || r.status === filter.status)
      .sort((a, b) => b.id.localeCompare(a.id))
      .filter((r) => !page.cursor || r.id < page.cursor);
    return {
      items: items.slice(0, page.limit),
      nextCursor: items.length > page.limit ? items[page.limit - 1]!.id : null,
    };
  }
}

export function makeDeps(overrides: Partial<WalletDeps> = {}) {
  const store = new InMemoryWallet();
  const topUps = new FakeTopUps();
  const creditRequests = new InMemoryCreditRequests();
  return {
    store,
    topUps,
    creditRequests,
    deps: {
      ledger: store,
      payouts: store,
      executor: new FakeExecutor(),
      topUps,
      fingerprints: {
        of: (phone: string) => createHmac('sha256', 'test-phone-hash-secret').update(phone).digest('hex'),
      },
      settings: {
        ledgerCallers: ['recovery'] as readonly string[],
        debitCallers: ['cleaning', 'billing'] as readonly string[],
        topUpMin: 500,
        topUpMax: 1_000_000,
        manualRefundMax: 100_000,
        creditApprovalThreshold: 50_000,
      },
      creditRequests,
      clock: new FixedClock(),
      ids: new SequenceIds(),
      ...overrides,
    } satisfies WalletDeps,
  };
}

function as<T>(
  userId: string,
  fn: () => Promise<T>,
  options: { roles?: string[]; mfa?: boolean; activeContext?: string; orgRole?: string } = {},
): Promise<T> {
  const roles: RoleClaim[] = (options.roles ?? ['customer']).map((role) => ({ role, scopeType: 'global' }));
  if (options.orgRole && options.activeContext) {
    roles.push({ role: options.orgRole, scopeType: 'org', scopeId: options.activeContext });
  }
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

/** Client connecté ; dans le contexte d'une organisation, avec son rôle de membre (org_admin par défaut). */
export function asCustomer<T>(
  fn: () => Promise<T>,
  organizationId?: string,
  orgRole = 'org_admin',
): Promise<T> {
  return as(USER_ID, fn, organizationId ? { activeContext: organizationId, orgRole } : {});
}

/** Service appelant, agissant pour un client connecté (métadonnées transmises par le kit). */
export function asServiceFor<T>(service: string, userId: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext(
    {
      correlationId: 'c-test',
      callerService: service,
      user: { userId, sessionId: 's-test', activeContext: 'personal', roles: [], mfa: false },
    },
    fn,
  );
}

export function asStaff<T>(
  fn: () => Promise<T>,
  role = 'finance_officer',
  mfa = true,
  userId = STAFF_ID,
): Promise<T> {
  return as(userId, fn, { roles: [role], mfa });
}

export function asService<T>(service: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ correlationId: 'c-test', callerService: service }, fn);
}
