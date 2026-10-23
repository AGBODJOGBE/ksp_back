import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import {
  type Changes,
  type CreateResult,
  type QuoteRequestFilter,
  type QuoteRequestRepository,
} from '../../application/ports';
import { type PageRequest, type PageResult } from '../../application/shared/validation';
import { type Mission } from '../../domain/mission';
import { type QuoteRequest } from '../../domain/quote-request';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import { cursorFilter, pageArgs, toPage, type Tx, writeChanges } from './changes';
import { missionCreateColumns } from './mission.mapper';
import { quoteColumns, REQUEST_INCLUDE, requestColumns, toRequest } from './quote-request.mapper';

const ids = new UuidV7Generator();

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class PrismaQuoteRequestRepository implements QuoteRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    request: QuoteRequest,
    idempotencyKey: string,
    changes: Changes,
  ): Promise<CreateResult<QuoteRequest>> {
    // INSERT … ON CONFLICT DO NOTHING : de deux appels simultanés avec la même clé, un seul insère.
    const created = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.quoteRequest.createMany({
        data: [
          {
            id: request.id,
            customerId: request.customerId,
            idempotencyKey,
            createdAt: request.createdAt,
            ...requestColumns(request),
          },
        ],
        skipDuplicates: true,
      });
      if (count === 1) await writeChanges(tx, changes, () => ids.next());
      return count === 1;
    });
    const stored = await this.findByIdempotencyKey(request.customerId, idempotencyKey);
    return { created, value: stored! };
  }

  async findByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<QuoteRequest | null> {
    const row = await this.prisma.quoteRequest.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
      include: REQUEST_INCLUDE,
    });
    return row ? toRequest(row) : null;
  }

  async findById(id: string): Promise<QuoteRequest | null> {
    const row = await this.prisma.quoteRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
    return row ? toRequest(row) : null;
  }

  async findAcceptance(requestId: string, idempotencyKey: string): Promise<string | null> {
    const row = await this.prisma.mission.findFirst({
      where: { requestId, acceptanceKey: idempotencyKey },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async findByVisitId(visitId: string): Promise<QuoteRequest | null> {
    const visit = await this.prisma.siteVisit.findUnique({
      where: { id: visitId },
      select: { requestId: true },
    });
    return visit ? this.findById(visit.requestId) : null;
  }

  async list(filter: QuoteRequestFilter, page: PageRequest): Promise<PageResult<QuoteRequest>> {
    const rows = await this.prisma.quoteRequest.findMany({
      where: { ...filter, ...cursorFilter(page) },
      include: REQUEST_INCLUDE,
      ...pageArgs(page),
    });
    const result = toPage(rows, page.limit);
    return { items: result.items.map(toRequest), nextCursor: result.nextCursor };
  }

  async countOpen(customerId: string, now: Date): Promise<number> {
    return this.prisma.quoteRequest.count({
      where: {
        customerId,
        OR: [
          { status: { in: ['received', 'visit_scheduled'] } },
          { status: 'quote_sent', quotes: { some: { validUntil: { gt: now } } } },
        ],
      },
    });
  }

  async save(request: QuoteRequest, changes: Changes): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.update(tx, request))) return false;
      await writeChanges(tx, changes, () => ids.next());
      return true;
    });
  }

  async accept(request: QuoteRequest, mission: Mission, idempotencyKey: string, changes: Changes) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (!(await this.update(tx, request))) return this.acceptanceOutcome(tx, request.id, idempotencyKey);
        await tx.mission.create({ data: missionCreateColumns(mission, idempotencyKey) });
        await writeChanges(tx, changes, () => ids.next());
        return { status: 'created' as const };
      });
    } catch (error) {
      // Deux acceptations simultanées : la contrainte d'unicité de missions.request_id tranche.
      if (isUniqueViolation(error)) return this.acceptanceOutcome(this.prisma, request.id, idempotencyKey);
      throw error;
    }
  }

  private async acceptanceOutcome(tx: Tx, requestId: string, idempotencyKey: string) {
    const existing = await tx.mission.findFirst({
      where: { requestId, acceptanceKey: idempotencyKey },
      select: { id: true },
    });
    return existing
      ? { status: 'replayed' as const, missionId: existing.id }
      : { status: 'conflict' as const };
  }

  /** Mise à jour conditionnée à la version lue (contrôle de concurrence optimiste). */
  private async update(tx: Tx, request: QuoteRequest): Promise<boolean> {
    const { count } = await tx.quoteRequest.updateMany({
      where: { id: request.id, version: request.version },
      data: { ...requestColumns(request), version: { increment: 1 } },
    });
    if (count === 0) return false;
    if (request.visit) {
      const visit = {
        status: request.visit.status,
        scheduledAt: request.visit.scheduledAt,
        agentId: request.visit.agentId,
        report: request.visit.report,
        completedAt: request.visit.completedAt,
      };
      await tx.siteVisit.upsert({
        where: { requestId: request.id },
        create: { id: request.visit.id, requestId: request.id, ...visit },
        update: { id: request.visit.id, ...visit },
      });
    }
    if (request.quote) {
      // Un devis envoyé est figé : on n'ajoute qu'une nouvelle version, jamais de modification.
      await tx.quote.upsert({
        where: { id: request.quote.id },
        create: quoteColumns(request.id, request.quote),
        update: {},
      });
    }
    return true;
  }
}
