import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import { Prisma, type PaymentLink as LinkRow, type Payout as PayoutRow } from '../../../prisma/generated';
import {
  type OutboxMessage,
  type PageRequest,
  type PageResult,
  type PaymentLinkRepository,
  type PayoutFilter,
  type PayoutRepository,
} from '../../application/ports';
import { type PaymentLink } from '../../domain/payment-link';
import {
  type Payout,
  type PayoutFailureCode,
  type PayoutOperator,
  type PayoutProviderName,
  type PayoutStatus,
} from '../../domain/payout';
import { PrismaService } from '../prisma/prisma.service';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function linkToDomain(row: LinkRow): PaymentLink {
  return {
    id: row.id,
    issuer: row.issuer,
    idempotencyKey: row.idempotencyKey,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    reference: row.reference,
    beneficiaryName: row.beneficiaryName,
    description: row.description,
    amount: row.amount,
    dueDate: row.dueDate,
    payerName: row.payerName,
    payerPhone: row.payerPhone,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** Liens de paiement (ADR-040) : seul l'état de révocation change après la création. */
@Injectable()
export class PrismaPaymentLinkRepository implements PaymentLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(link: PaymentLink, tokenHash: string): Promise<{ created: boolean; link: PaymentLink }> {
    try {
      const row = await this.prisma.paymentLink.create({
        data: {
          id: link.id,
          tokenHash,
          issuer: link.issuer,
          idempotencyKey: link.idempotencyKey,
          subjectType: link.subjectType,
          subjectId: link.subjectId,
          reference: link.reference,
          beneficiaryName: link.beneficiaryName,
          description: link.description,
          amount: link.amount,
          currency: 'XOF',
          dueDate: link.dueDate,
          payerName: link.payerName,
          payerPhone: link.payerPhone,
          expiresAt: link.expiresAt,
          revokedAt: link.revokedAt,
          revokedReason: link.revokedReason,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt,
          version: link.version,
        },
      });
      return { created: true, link: linkToDomain(row) };
    } catch (error) {
      // Envoi concurrent avec la même clé : le premier enregistré fait foi.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findByIssuerKey(link.issuer, link.idempotencyKey);
      if (!existing) throw error;
      return { created: false, link: existing };
    }
  }

  async findById(id: string): Promise<PaymentLink | null> {
    const row = await this.prisma.paymentLink.findUnique({ where: { id } });
    return row ? linkToDomain(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<PaymentLink | null> {
    const row = await this.prisma.paymentLink.findUnique({ where: { tokenHash } });
    return row ? linkToDomain(row) : null;
  }

  async findByIssuerKey(issuer: string, idempotencyKey: string): Promise<PaymentLink | null> {
    const row = await this.prisma.paymentLink.findUnique({
      where: { issuer_idempotencyKey: { issuer, idempotencyKey } },
    });
    return row ? linkToDomain(row) : null;
  }

  async listForSubject(subjectType: string, subjectId: string): Promise<PaymentLink[]> {
    const rows = await this.prisma.paymentLink.findMany({
      where: { subjectType, subjectId },
      orderBy: { id: 'desc' },
    });
    return rows.map(linkToDomain);
  }

  async save(link: PaymentLink): Promise<boolean> {
    const { count } = await this.prisma.paymentLink.updateMany({
      where: { id: link.id, version: link.version },
      data: {
        revokedAt: link.revokedAt,
        revokedReason: link.revokedReason,
        updatedAt: link.updatedAt,
        version: { increment: 1 },
      },
    });
    return count === 1;
  }
}

function payoutToDomain(row: PayoutRow): Payout {
  return {
    id: row.id,
    issuer: row.issuer,
    idempotencyKey: row.idempotencyKey,
    reference: row.reference,
    amount: row.amount,
    beneficiary: {
      phone: row.beneficiaryPhone,
      operator: row.beneficiaryOperator as PayoutOperator,
      name: row.beneficiaryName,
    },
    status: row.status as PayoutStatus,
    provider: row.provider as PayoutProviderName,
    providerPayoutId: row.providerPayoutId,
    providerReference: row.providerReference,
    failureCode: (row.failureCode as PayoutFailureCode | null) ?? null,
    failureReason: row.failureReason,
    settledBy: row.settledBy,
    settlementKey: row.settlementKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt,
    completedAt: row.completedAt,
    failedAt: row.failedAt,
    lastCheckedAt: row.lastCheckedAt,
    version: row.version,
  };
}

/** Colonnes modifiables (l'émetteur, le montant et le bénéficiaire ne changent jamais). */
function mutablePayoutColumns(payout: Payout) {
  return {
    status: payout.status,
    providerPayoutId: payout.providerPayoutId,
    providerReference: payout.providerReference,
    failureCode: payout.failureCode,
    failureReason: payout.failureReason,
    settledBy: payout.settledBy,
    settlementKey: payout.settlementKey,
    updatedAt: payout.updatedAt,
    submittedAt: payout.submittedAt,
    completedAt: payout.completedAt,
    failedAt: payout.failedAt,
    lastCheckedAt: payout.lastCheckedAt,
  };
}

/** Reversements (ADR-041) : chaque changement d'état avec son événement, sous contrôle de version. */
@Injectable()
export class PrismaPayoutRepository implements PayoutRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(payout: Payout): Promise<{ created: boolean; payout: Payout }> {
    try {
      const row = await this.prisma.payout.create({
        data: {
          id: payout.id,
          issuer: payout.issuer,
          idempotencyKey: payout.idempotencyKey,
          reference: payout.reference,
          amount: payout.amount,
          currency: 'XOF',
          beneficiaryPhone: payout.beneficiary.phone,
          beneficiaryOperator: payout.beneficiary.operator,
          beneficiaryName: payout.beneficiary.name,
          provider: payout.provider,
          createdAt: payout.createdAt,
          version: payout.version,
          ...mutablePayoutColumns(payout),
        },
      });
      return { created: true, payout: payoutToDomain(row) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findByIssuerKey(payout.issuer, payout.idempotencyKey);
      if (!existing) throw error;
      return { created: false, payout: existing };
    }
  }

  async findById(id: string): Promise<Payout | null> {
    const row = await this.prisma.payout.findUnique({ where: { id } });
    return row ? payoutToDomain(row) : null;
  }

  async findByIssuerKey(issuer: string, idempotencyKey: string): Promise<Payout | null> {
    const row = await this.prisma.payout.findUnique({
      where: { issuer_idempotencyKey: { issuer, idempotencyKey } },
    });
    return row ? payoutToDomain(row) : null;
  }

  async findByProviderPayoutId(
    provider: PayoutProviderName,
    providerPayoutId: string,
  ): Promise<Payout | null> {
    const row = await this.prisma.payout.findUnique({
      where: { provider_providerPayoutId: { provider, providerPayoutId } },
    });
    return row ? payoutToDomain(row) : null;
  }

  save(payout: Payout, events: OutboxMessage[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payout.updateMany({
        where: { id: payout.id, version: payout.version },
        data: { ...mutablePayoutColumns(payout), version: { increment: 1 } },
      });
      if (count === 0) return false;
      for (const event of events) {
        await appendToOutbox(
          tx as unknown as SqlExecutor,
          createEnvelope(event.type, event.payload as never, { producer: 'payment' }),
        );
      }
      return true;
    });
  }

  async list(filter: PayoutFilter, page: PageRequest): Promise<PageResult<Payout>> {
    const rows = await this.prisma.payout.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.issuer ? { issuer: filter.issuer } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(payoutToDomain);
    return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
  }

  async listToReconcile(input: {
    provider: PayoutProviderName;
    checkedBefore: Date;
    limit: number;
  }): Promise<Payout[]> {
    const rows = await this.prisma.payout.findMany({
      where: {
        provider: input.provider,
        OR: [
          { status: 'requested' },
          {
            status: 'processing',
            OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: input.checkedBefore } }],
          },
        ],
      },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take: input.limit,
    });
    return rows.map(payoutToDomain);
  }
}
