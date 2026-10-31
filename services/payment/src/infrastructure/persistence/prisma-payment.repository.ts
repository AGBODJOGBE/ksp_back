import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { Injectable } from '@nestjs/common';
import { Prisma, type PaymentIntent as PaymentRow } from '../../../prisma/generated';
import {
  type NotificationOutcome,
  type OutboxMessage,
  type PageRequest,
  type PageResult,
  type PaymentFilter,
  type PaymentRepository,
  type ProviderNotificationLog,
} from '../../application/ports';
import {
  type FailureReason,
  LATE_SUCCESS_STATUSES,
  type MissionPart,
  type PaymentIntent,
  type PaymentStatus,
  type ProviderName,
  type SubjectType,
} from '../../domain/payment-intent';
import { PrismaService } from '../prisma/prisma.service';

function toDomain(row: PaymentRow): PaymentIntent {
  return {
    id: row.id,
    subject: {
      type: row.subjectType as SubjectType,
      id: row.subjectId,
      part: (row.part as MissionPart | null) ?? null,
      reference: row.subjectReference,
    },
    amount: row.amount,
    customerId: row.customerId,
    organizationId: row.organizationId,
    status: row.status as PaymentStatus,
    provider: row.provider as ProviderName,
    providerTransactionId: row.providerTransactionId,
    providerReference: row.providerReference,
    checkoutUrl: row.checkoutUrl,
    idempotencyKey: row.idempotencyKey,
    failureReason: (row.failureReason as FailureReason | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    completedAt: row.completedAt,
    lastCheckedAt: row.lastCheckedAt,
    version: row.version,
  };
}

/** Colonnes modifiables d'un paiement (l'objet payé, le montant et le payeur ne changent jamais). */
function mutableColumns(intent: PaymentIntent) {
  return {
    status: intent.status,
    providerTransactionId: intent.providerTransactionId,
    providerReference: intent.providerReference,
    checkoutUrl: intent.checkoutUrl,
    failureReason: intent.failureReason,
    updatedAt: intent.updatedAt,
    completedAt: intent.completedAt,
    lastCheckedAt: intent.lastCheckedAt,
  };
}

/** Rapprochement : jamais relus d'abord, puis les plus anciennement relus (aucun n'est oublié). */
const BY_LAST_CHECK = [
  { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
  { createdAt: 'asc' },
] satisfies Prisma.PaymentIntentOrderByWithRelationInput[];

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(intent: PaymentIntent): Promise<{ created: boolean; intent: PaymentIntent }> {
    try {
      const row = await this.prisma.paymentIntent.create({
        data: {
          id: intent.id,
          subjectType: intent.subject.type,
          subjectId: intent.subject.id,
          part: intent.subject.part,
          subjectReference: intent.subject.reference,
          amount: intent.amount,
          currency: 'XOF',
          customerId: intent.customerId,
          organizationId: intent.organizationId,
          provider: intent.provider,
          idempotencyKey: intent.idempotencyKey,
          createdAt: intent.createdAt,
          expiresAt: intent.expiresAt,
          version: intent.version,
          ...mutableColumns(intent),
        },
      });
      return { created: true, intent: toDomain(row) };
    } catch (error) {
      // Envoi concurrent avec la même clé : le premier enregistré fait foi.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findByIdempotencyKey(intent.customerId, intent.idempotencyKey);
      if (!existing) throw error;
      return { created: false, intent: existing };
    }
  }

  async findById(id: string): Promise<PaymentIntent | null> {
    const row = await this.prisma.paymentIntent.findUnique({ where: { id } });
    return row ? toDomain(row) : null;
  }

  async findByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<PaymentIntent | null> {
    const row = await this.prisma.paymentIntent.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
    });
    return row ? toDomain(row) : null;
  }

  async findByTransaction(provider: ProviderName, transactionId: string): Promise<PaymentIntent | null> {
    const row = await this.prisma.paymentIntent.findUnique({
      where: { provider_providerTransactionId: { provider, providerTransactionId: transactionId } },
    });
    return row ? toDomain(row) : null;
  }

  async findOpen(input: {
    customerId: string;
    subjectType: SubjectType;
    subjectId: string;
    part: string | null;
    now: Date;
  }): Promise<PaymentIntent | null> {
    const row = await this.prisma.paymentIntent.findFirst({
      where: {
        customerId: input.customerId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        part: input.part,
        status: 'pending',
        expiresAt: { gt: input.now },
      },
      orderBy: { id: 'desc' },
    });
    return row ? toDomain(row) : null;
  }

  save(intent: PaymentIntent, events: OutboxMessage[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.paymentIntent.updateMany({
        where: { id: intent.id, version: intent.version },
        data: { ...mutableColumns(intent), version: { increment: 1 } },
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

  async list(filter: PaymentFilter, page: PageRequest): Promise<PageResult<PaymentIntent>> {
    const rows = await this.prisma.paymentIntent.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.subjectType ? { subjectType: filter.subjectType } : {}),
        ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.organizationId !== undefined ? { organizationId: filter.organizationId } : {}),
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(toDomain);
    return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
  }

  async listPendingToReconcile(input: {
    checkedBefore: Date;
    createdBefore: Date;
    limit: number;
  }): Promise<PaymentIntent[]> {
    const rows = await this.prisma.paymentIntent.findMany({
      where: {
        status: 'pending',
        createdAt: { lt: input.createdBefore },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: input.checkedBefore } }],
      },
      orderBy: BY_LAST_CHECK,
      take: input.limit,
    });
    return rows.map(toDomain);
  }

  async listClosedToReconcile(input: {
    checkedBefore: Date;
    lateSince: Date;
    limit: number;
  }): Promise<PaymentIntent[]> {
    const rows = await this.prisma.paymentIntent.findMany({
      where: {
        status: { in: [...LATE_SUCCESS_STATUSES] },
        providerTransactionId: { not: null },
        completedAt: { gte: input.lateSince },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: input.checkedBefore } }],
      },
      orderBy: BY_LAST_CHECK,
      take: input.limit,
    });
    return rows.map(toDomain);
  }
}

@Injectable()
export class PrismaProviderNotificationLog implements ProviderNotificationLog {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: {
    id: string;
    provider: ProviderName;
    eventName: string;
    providerEventId: string | null;
    providerTransactionId: string | null;
    paymentId: string | null;
    outcome: NotificationOutcome;
    receivedAt: Date;
  }): Promise<void> {
    await this.prisma.providerNotification.create({ data: entry });
  }
}
