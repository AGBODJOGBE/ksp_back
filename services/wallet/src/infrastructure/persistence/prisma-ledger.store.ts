import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type LedgerTransaction as TransactionRow,
  type WalletPayout as PayoutRow,
} from '../../../prisma/generated';
import {
  type LedgerOverview,
  type LedgerStore,
  type PageRequest,
  type PageResult,
  type PayoutFilter,
  type RecordOutcome,
  type StatementLine,
  type WalletPayoutRepository,
  type WalletSummary,
} from '../../application/ports';
import {
  type AccountCode,
  type Direction,
  type Holder,
  holderAccount,
  type HolderType,
  INTERNAL_ACCOUNTS,
  isBalanced,
  type LedgerTransaction,
  type TransactionKind,
} from '../../domain/ledger';
import { type Operator, type WalletPayout, type WalletPayoutStatus } from '../../domain/wallet-payout';
import { PrismaService } from '../prisma/prisma.service';
import { v7 as uuidv7 } from 'uuid';

type Tx = Prisma.TransactionClient;

const num = (value: bigint | null): number | null => (value === null ? null : Number(value));

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function payoutToDomain(row: PayoutRow): WalletPayout {
  return {
    id: row.id,
    caller: row.caller,
    idempotencyKey: row.idempotencyKey,
    holder: { type: row.holderType as HolderType, id: row.holderId },
    amount: Number(row.amount),
    status: row.status as WalletPayoutStatus,
    beneficiaryPhone: row.beneficiaryPhone,
    beneficiaryName: row.beneficiaryName,
    beneficiaryPhoneMasked: row.beneficiaryPhoneMasked,
    beneficiaryOperator: row.beneficiaryOperator as Operator,
    paymentPayoutId: row.paymentPayoutId,
    holdTransactionId: row.holdTransactionId,
    settlementTransactionId: row.settlementTransactionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    completedAt: row.completedAt,
    failedAt: row.failedAt,
    version: row.version,
  };
}

/** Colonnes modifiables d'un reversement (titulaire, montant et retenue ne changent jamais). */
function mutablePayoutColumns(payout: WalletPayout) {
  return {
    status: payout.status,
    beneficiaryPhone: payout.beneficiaryPhone,
    beneficiaryName: payout.beneficiaryName,
    paymentPayoutId: payout.paymentPayoutId,
    settlementTransactionId: payout.settlementTransactionId,
    updatedAt: payout.updatedAt,
    submittedAt: payout.submittedAt,
    completedAt: payout.completedAt,
    failedAt: payout.failedAt,
  };
}

/** Le sous-ensemble du client Prisma utile aux lectures (client ou transaction). */
type Reader = Pick<Tx, 'ledgerTransaction' | 'ledgerEntry'>;

async function withEntries(db: Reader, rows: TransactionRow[]): Promise<LedgerTransaction[]> {
  if (rows.length === 0) return [];
  const entries = await db.ledgerEntry.findMany({
    where: { transactionId: { in: rows.map((row) => row.id) } },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as TransactionKind,
    caller: row.caller,
    reference: row.reference,
    holder: { type: row.holderType as HolderType, id: row.holderId },
    amount: Number(row.amount),
    grossAmount: num(row.grossAmount),
    commission: num(row.commission),
    commissionRateBps: row.commissionRateBps,
    description: row.description,
    reversesTransactionId: row.reversesTransactionId,
    payoutId: row.payoutId,
    createdAt: row.createdAt,
    entries: entries
      .filter((entry) => entry.transactionId === row.id)
      .map((entry) => ({
        account: entry.accountCode as AccountCode,
        direction: entry.direction as Direction,
        amount: Number(entry.amount),
      })),
  }));
}

/** Annulation de toute la transaction Prisma, avec l'issue à rendre. */
class Abort extends Error {
  constructor(readonly outcome: RecordOutcome) {
    super(outcome.kind);
  }
}

/**
 * Grand livre et reversements dans PostgreSQL (ADR-042). Les soldes et `balance_after` sont tenus
 * par un déclencheur à chaque écriture, l'équilibre de chaque transaction est vérifié par la base à
 * la validation, et les écritures y sont immuables (mise à jour et suppression refusées).
 */
@Injectable()
export class PrismaLedgerStore implements LedgerStore, WalletPayoutRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: Parameters<LedgerStore['record']>[0]): Promise<RecordOutcome> {
    const tx = input.transaction;
    if (!isBalanced(tx.entries)) throw new Error(`Transaction ${tx.id} déséquilibrée.`);
    try {
      return await this.prisma.$transaction(async (db) => {
        if (input.inbox) {
          const inserted = await db.$executeRawUnsafe(
            'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
              'ON CONFLICT DO NOTHING',
            input.inbox.eventId,
            input.inbox.consumer,
          );
          if (inserted === 0) throw new Abort({ kind: 'already_processed' });
        }
        const holderCode = holderAccount(tx.holder);
        // Compte du titulaire créé au besoin, puis verrouillé : le solde contrôlé ne bouge plus.
        await db.$executeRawUnsafe(
          'INSERT INTO ledger_accounts (code, kind, holder_type, holder_id, normal_side) ' +
            "VALUES ($1, 'holder', $2, $3::uuid, 'credit') ON CONFLICT (code) DO NOTHING",
          holderCode,
          tx.holder.type,
          tx.holder.id,
        );
        const [locked] = await db.$queryRawUnsafe<{ balance: bigint }[]>(
          'SELECT balance FROM ledger_accounts WHERE code = $1 FOR UPDATE',
          holderCode,
        );
        const balance = Number(locked?.balance ?? 0);
        if (input.requireHolderBalance !== undefined && balance < input.requireHolderBalance) {
          throw new Abort({ kind: 'insufficient', balance });
        }
        await db.ledgerTransaction.create({
          data: {
            id: tx.id,
            kind: tx.kind,
            caller: tx.caller,
            reference: tx.reference,
            holderType: tx.holder.type,
            holderId: tx.holder.id,
            amount: BigInt(tx.amount),
            grossAmount: tx.grossAmount === null ? null : BigInt(tx.grossAmount),
            commission: tx.commission === null ? null : BigInt(tx.commission),
            commissionRateBps: tx.commissionRateBps,
            description: tx.description,
            reversesTransactionId: tx.reversesTransactionId,
            payoutId: tx.payoutId,
            createdAt: tx.createdAt,
          },
        });
        // Une ligne à la fois : le déclencheur met à jour le solde de chaque compte dans l'ordre.
        for (const line of tx.entries) {
          await db.ledgerEntry.create({
            data: {
              id: uuidv7(),
              transactionId: tx.id,
              accountCode: line.account,
              direction: line.direction,
              amount: BigInt(line.amount),
              createdAt: tx.createdAt,
            },
          });
        }
        if (input.createPayout) {
          const payout = input.createPayout;
          await db.walletPayout.create({
            data: {
              id: payout.id,
              caller: payout.caller,
              idempotencyKey: payout.idempotencyKey,
              holderType: payout.holder.type,
              holderId: payout.holder.id,
              amount: BigInt(payout.amount),
              beneficiaryPhoneMasked: payout.beneficiaryPhoneMasked,
              beneficiaryOperator: payout.beneficiaryOperator,
              holdTransactionId: payout.holdTransactionId,
              createdAt: payout.createdAt,
              version: payout.version,
              ...mutablePayoutColumns(payout),
            },
          });
        }
        if (input.updatePayout) {
          const { count } = await db.walletPayout.updateMany({
            where: { id: input.updatePayout.id, version: input.updatePayout.version },
            data: { ...mutablePayoutColumns(input.updatePayout), version: { increment: 1 } },
          });
          if (count === 0) throw new Abort({ kind: 'conflict' });
        }
        const [after] = await db.$queryRawUnsafe<{ balance: bigint }[]>(
          'SELECT balance FROM ledger_accounts WHERE code = $1',
          holderCode,
        );
        return { kind: 'recorded', transaction: tx, holderBalance: Number(after?.balance ?? 0) } as const;
      });
    } catch (error) {
      if (error instanceof Abort) return error.outcome;
      // Référence, annulation ou clé de reversement déjà enregistrées (envoi simultané).
      if (isUniqueViolation(error)) return { kind: 'duplicate' };
      throw error;
    }
  }

  async findTransaction(id: string): Promise<LedgerTransaction | null> {
    const row = await this.prisma.ledgerTransaction.findUnique({ where: { id } });
    return row ? ((await withEntries(this.prisma, [row]))[0] ?? null) : null;
  }

  async findByReference(caller: string, reference: string): Promise<LedgerTransaction | null> {
    const row = await this.prisma.ledgerTransaction.findUnique({
      where: { caller_reference: { caller, reference } },
    });
    return row ? ((await withEntries(this.prisma, [row]))[0] ?? null) : null;
  }

  async findReversalOf(transactionId: string): Promise<LedgerTransaction | null> {
    const row = await this.prisma.ledgerTransaction.findUnique({
      where: { reversesTransactionId: transactionId },
    });
    return row ? ((await withEntries(this.prisma, [row]))[0] ?? null) : null;
  }

  async summary(holder: Holder): Promise<WalletSummary> {
    const code = holderAccount(holder);
    const where = { holderType: holder.type, holderId: holder.id };
    const [account, last, collected, reversed, inProgress, paidOut] = await Promise.all([
      this.prisma.ledgerAccount.findUnique({ where: { code } }),
      this.prisma.ledgerEntry.findFirst({ where: { accountCode: code }, orderBy: { id: 'desc' } }),
      this.prisma.ledgerTransaction.aggregate({
        where: { ...where, kind: 'collection' },
        _sum: { amount: true },
      }),
      this.prisma.ledgerTransaction.aggregate({
        where: { ...where, kind: 'reversal' },
        _sum: { amount: true },
      }),
      this.prisma.walletPayout.aggregate({
        where: { ...where, status: { in: ['pending_submission', 'submitted'] } },
        _sum: { amount: true },
      }),
      this.prisma.walletPayout.aggregate({
        where: { ...where, status: 'completed' },
        _sum: { amount: true },
      }),
    ]);
    const sum = (value: bigint | null) => Number(value ?? 0n);
    return {
      holder,
      balance: Number(account?.balance ?? 0n),
      payoutsInProgress: sum(inProgress._sum.amount),
      totalCollected: sum(collected._sum.amount) - sum(reversed._sum.amount),
      totalPaidOut: sum(paidOut._sum.amount),
      lastEntryAt: last?.createdAt ?? null,
    };
  }

  async statement(holder: Holder, page: PageRequest): Promise<PageResult<StatementLine>> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: { accountCode: holderAccount(holder), ...(page.cursor ? { id: { lt: page.cursor } } : {}) },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const shown = entries.slice(0, page.limit);
    const rows = await this.prisma.ledgerTransaction.findMany({
      where: { id: { in: [...new Set(shown.map((entry) => entry.transactionId))] } },
    });
    const transactions = new Map((await withEntries(this.prisma, rows)).map((t) => [t.id, t]));
    const payoutIds = [...transactions.values()].map((t) => t.payoutId).filter((id): id is string => !!id);
    const payouts = new Map(
      (await this.prisma.walletPayout.findMany({ where: { id: { in: payoutIds } } })).map((p) => [
        p.id,
        p.status as WalletPayoutStatus,
      ]),
    );
    const items = shown.map((entry) => {
      const transaction = transactions.get(entry.transactionId)!;
      return {
        entryId: entry.id,
        transaction,
        direction: entry.direction as Direction,
        amount: Number(entry.amount),
        balanceAfter: Number(entry.balanceAfter),
        payoutStatus: transaction.payoutId ? (payouts.get(transaction.payoutId) ?? null) : null,
      };
    });
    return { items, nextCursor: entries.length > page.limit ? items.at(-1)!.entryId : null };
  }

  async overview(): Promise<LedgerOverview> {
    const [internal, holders] = await Promise.all([
      this.prisma.ledgerAccount.findMany({ where: { kind: 'internal' } }),
      this.prisma.ledgerAccount.aggregate({
        where: { kind: 'holder' },
        _sum: { balance: true },
        _count: true,
      }),
    ]);
    const balances = new Map(internal.map((account) => [account.code, Number(account.balance)]));
    return {
      internal: INTERNAL_ACCOUNTS.map((account) => ({ account, balance: balances.get(account) ?? 0 })),
      owedToHolders: Number(holders._sum.balance ?? 0n),
      holdersCount: holders._count,
    };
  }

  // --- Reversements -------------------------------------------------------------------------------

  async findById(id: string): Promise<WalletPayout | null> {
    const row = await this.prisma.walletPayout.findUnique({ where: { id } });
    return row ? payoutToDomain(row) : null;
  }

  async findByKey(caller: string, idempotencyKey: string): Promise<WalletPayout | null> {
    const row = await this.prisma.walletPayout.findUnique({
      where: { caller_idempotencyKey: { caller, idempotencyKey } },
    });
    return row ? payoutToDomain(row) : null;
  }

  async save(payout: WalletPayout): Promise<boolean> {
    const { count } = await this.prisma.walletPayout.updateMany({
      where: { id: payout.id, version: payout.version },
      data: { ...mutablePayoutColumns(payout), version: { increment: 1 } },
    });
    return count === 1;
  }

  async list(filter: PayoutFilter, page: PageRequest): Promise<PageResult<WalletPayout>> {
    const rows = await this.prisma.walletPayout.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.holder ? { holderType: filter.holder.type, holderId: filter.holder.id } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(payoutToDomain);
    return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
  }

  async listPendingSubmission(limit: number): Promise<WalletPayout[]> {
    const rows = await this.prisma.walletPayout.findMany({
      where: { status: 'pending_submission' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map(payoutToDomain);
  }
}
