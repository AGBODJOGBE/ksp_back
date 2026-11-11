import { Injectable } from '@nestjs/common';
import { Prisma, type ManualCreditRequest as Row } from '../../../prisma/generated';
import {
  type CreditKind,
  type ManualCreditRequest,
  type ManualCreditRequests,
  type ManualCreditStatus,
  type PageRequest,
  type PageResult,
} from '../../application/ports';
import { type HolderType } from '../../domain/ledger';
import { PrismaService } from '../prisma/prisma.service';

function toDomain(row: Row): ManualCreditRequest {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    holder: { type: row.holderType as HolderType, id: row.holderId },
    kind: row.kind as CreditKind,
    amount: Number(row.amount),
    reason: row.reason,
    paymentId: row.paymentId,
    status: row.status as ManualCreditStatus,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    transactionId: row.transactionId,
    version: row.version,
  };
}

/** Demandes de crédit manuel soumises à double validation (ADR-048). */
@Injectable()
export class PrismaCreditRequests implements ManualCreditRequests {
  constructor(private readonly prisma: PrismaService) {}

  async create(request: ManualCreditRequest): Promise<{ created: boolean; request: ManualCreditRequest }> {
    try {
      const row = await this.prisma.manualCreditRequest.create({
        data: {
          id: request.id,
          idempotencyKey: request.idempotencyKey,
          holderType: request.holder.type,
          holderId: request.holder.id,
          kind: request.kind,
          amount: BigInt(request.amount),
          reason: request.reason,
          paymentId: request.paymentId,
          status: request.status,
          requestedBy: request.requestedBy,
          requestedAt: request.requestedAt,
          version: request.version,
        },
      });
      return { created: true, request: toDomain(row) };
    } catch (error) {
      // Même clé envoyée deux fois en même temps : la première demande fait foi.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existing = await this.findByKey(request.idempotencyKey);
      if (!existing) throw error;
      return { created: false, request: existing };
    }
  }

  async findById(id: string): Promise<ManualCreditRequest | null> {
    const row = await this.prisma.manualCreditRequest.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByKey(idempotencyKey: string): Promise<ManualCreditRequest | null> {
    const row = await this.prisma.manualCreditRequest.findUnique({ where: { idempotencyKey } });
    return row ? toDomain(row) : null;
  }

  async save(request: ManualCreditRequest): Promise<boolean> {
    const { count } = await this.prisma.manualCreditRequest.updateMany({
      where: { id: request.id, version: request.version },
      data: {
        status: request.status,
        approvedBy: request.approvedBy,
        approvedAt: request.approvedAt,
        transactionId: request.transactionId,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }

  async list(
    filter: { status?: ManualCreditStatus },
    page: PageRequest,
  ): Promise<PageResult<ManualCreditRequest>> {
    const rows = await this.prisma.manualCreditRequest.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(toDomain);
    return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
  }
}
