import { Injectable } from '@nestjs/common';
import { type Prisma, type WalletWithdrawal as Row } from '../../../prisma/generated';
import {
  type PageRequest,
  type PageResult,
  type WithdrawalFilter,
  type WithdrawalRepository,
} from '../../application/ports';
import { type Holder, type HolderType } from '../../domain/ledger';
import { type Operator } from '../../domain/wallet-payout';
import { type Withdrawal, WITHDRAWALS_IN_PROGRESS, type WithdrawalStatus } from '../../domain/withdrawal';
import { PrismaService } from '../prisma/prisma.service';

export function withdrawalToDomain(row: Row): Withdrawal {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    holder: { type: row.holderType as HolderType, id: row.holderId },
    amount: Number(row.amount),
    status: row.status as WithdrawalStatus,
    beneficiaryPhone: row.beneficiaryPhone,
    beneficiaryName: row.beneficiaryName,
    beneficiaryPhoneMasked: row.beneficiaryPhoneMasked,
    beneficiaryPhoneHash: row.beneficiaryPhoneHash,
    beneficiaryOperator: row.beneficiaryOperator as Operator,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    processedBy: row.processedBy,
    processedAt: row.processedAt,
    processingNote: row.processingNote,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    rejectedBy: row.rejectedBy,
    rejectedAt: row.rejectedAt,
    rejectionReason: row.rejectionReason,
    paymentPayoutId: row.paymentPayoutId,
    holdTransactionId: row.holdTransactionId,
    settlementTransactionId: row.settlementTransactionId,
    completedAt: row.completedAt,
    failedAt: row.failedAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** Colonnes modifiables d'un retrait (titulaire, montant, bénéficiaire masqué et retenue ne changent jamais). */
export function mutableWithdrawalColumns(withdrawal: Withdrawal) {
  return {
    status: withdrawal.status,
    beneficiaryPhone: withdrawal.beneficiaryPhone,
    beneficiaryName: withdrawal.beneficiaryName,
    processedBy: withdrawal.processedBy,
    processedAt: withdrawal.processedAt,
    processingNote: withdrawal.processingNote,
    approvedBy: withdrawal.approvedBy,
    approvedAt: withdrawal.approvedAt,
    rejectedBy: withdrawal.rejectedBy,
    rejectedAt: withdrawal.rejectedAt,
    rejectionReason: withdrawal.rejectionReason,
    paymentPayoutId: withdrawal.paymentPayoutId,
    settlementTransactionId: withdrawal.settlementTransactionId,
    completedAt: withdrawal.completedAt,
    failedAt: withdrawal.failedAt,
    updatedAt: withdrawal.updatedAt,
  };
}

/** Ligne complète d'un nouveau retrait (créé avec sa retenue, dans la transaction de l'écriture). */
export function newWithdrawalRow(withdrawal: Withdrawal): Prisma.WalletWithdrawalUncheckedCreateInput {
  return {
    id: withdrawal.id,
    idempotencyKey: withdrawal.idempotencyKey,
    holderType: withdrawal.holder.type,
    holderId: withdrawal.holder.id,
    amount: BigInt(withdrawal.amount),
    beneficiaryPhoneMasked: withdrawal.beneficiaryPhoneMasked,
    beneficiaryPhoneHash: withdrawal.beneficiaryPhoneHash,
    beneficiaryOperator: withdrawal.beneficiaryOperator,
    requestedBy: withdrawal.requestedBy,
    requestedAt: withdrawal.requestedAt,
    holdTransactionId: withdrawal.holdTransactionId,
    version: withdrawal.version,
    ...mutableWithdrawalColumns(withdrawal),
  };
}

/** Montant retenu par les retraits pas encore terminés d'un titulaire. */
export async function withdrawalsInProgress(
  db: Pick<Prisma.TransactionClient, 'walletWithdrawal'>,
  holder: Holder,
): Promise<number> {
  const { _sum } = await db.walletWithdrawal.aggregate({
    where: {
      holderType: holder.type,
      holderId: holder.id,
      status: { in: [...WITHDRAWALS_IN_PROGRESS] },
    },
    _sum: { amount: true },
  });
  return Number(_sum.amount ?? 0n);
}

/**
 * Retraits du portefeuille prépayé (R-WL-04). Création et changements avec écriture : par
 * PrismaLedgerStore.record, dans la même transaction ; ici, lectures et changements sans écriture.
 */
@Injectable()
export class PrismaWithdrawals implements WithdrawalRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Withdrawal | null> {
    const row = await this.prisma.walletWithdrawal.findUnique({ where: { id } });
    return row ? withdrawalToDomain(row) : null;
  }

  async findByKey(holder: Holder, idempotencyKey: string): Promise<Withdrawal | null> {
    const row = await this.prisma.walletWithdrawal.findUnique({
      where: {
        holderType_holderId_idempotencyKey: { holderType: holder.type, holderId: holder.id, idempotencyKey },
      },
    });
    return row ? withdrawalToDomain(row) : null;
  }

  async save(withdrawal: Withdrawal): Promise<boolean> {
    const { count } = await this.prisma.walletWithdrawal.updateMany({
      where: { id: withdrawal.id, version: withdrawal.version },
      data: { ...mutableWithdrawalColumns(withdrawal), version: { increment: 1 } },
    });
    return count === 1;
  }

  async list(
    filter: WithdrawalFilter,
    page: PageRequest,
    order: 'newest' | 'oldest',
  ): Promise<PageResult<Withdrawal>> {
    const newest = order === 'newest';
    const rows = await this.prisma.walletWithdrawal.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.holder ? { holderType: filter.holder.type, holderId: filter.holder.id } : {}),
        ...(page.cursor ? { id: newest ? { lt: page.cursor } : { gt: page.cursor } } : {}),
      },
      orderBy: { id: newest ? 'desc' : 'asc' },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(withdrawalToDomain);
    return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
  }
}
