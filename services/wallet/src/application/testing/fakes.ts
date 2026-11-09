import { AppError, type RoleClaim, runWithContext } from '@ksp/platform';
import {
  type AccountCode,
  balanceDelta,
  type Holder,
  holderAccount,
  INTERNAL_ACCOUNTS,
  isBalanced,
  type LedgerTransaction,
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
  type RecordOutcome,
  type StatementLine,
  type WalletDeps,
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
    const holderCode = holderAccount(tx.holder);
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
    return { kind: 'recorded', transaction: tx, holderBalance: this.balances.get(holderCode) ?? 0 };
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
    };
  }
  async statement(holder: Holder, page: PageRequest): Promise<PageResult<StatementLine>> {
    const code = holderAccount(holder);
    const lines = this.entries
      .filter((e) => e.account === code)
      .reverse()
      .filter((e) => !page.cursor || e.id < page.cursor)
      .map((e) => {
        const transaction = this.transactions.get(e.transactionId)!;
        const payout = transaction.payoutId ? this.payoutRows.get(transaction.payoutId) : undefined;
        return {
          entryId: e.id,
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
    const holders = [...this.balances.entries()].filter(([code]) => code.startsWith('holder:'));
    return {
      internal: INTERNAL_ACCOUNTS.map((account) => ({ account, balance: this.balances.get(account) ?? 0 })),
      owedToHolders: holders.reduce((sum, [, balance]) => sum + balance, 0),
      holdersCount: holders.length,
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

export function makeDeps(overrides: Partial<WalletDeps> = {}) {
  const store = new InMemoryWallet();
  return {
    store,
    deps: {
      ledger: store,
      payouts: store,
      executor: new FakeExecutor(),
      settings: { ledgerCallers: ['recovery'] as readonly string[] },
      clock: new FixedClock(),
      ids: new SequenceIds(),
      ...overrides,
    } satisfies WalletDeps,
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

export function asCustomer<T>(fn: () => Promise<T>, organizationId?: string): Promise<T> {
  return as(USER_ID, fn, organizationId ? { activeContext: organizationId } : {});
}

export function asStaff<T>(fn: () => Promise<T>, role = 'finance_officer', mfa = true): Promise<T> {
  return as(STAFF_ID, fn, { roles: [role], mfa });
}

export function asService<T>(service: string, fn: () => Promise<T>): Promise<T> {
  return runWithContext({ correlationId: 'c-test', callerService: service }, fn);
}
