import { Injectable } from '@nestjs/common';
import { Prisma, type QuoteRequestGroup as GroupRow } from '../../../prisma/generated';
import {
  type Changes,
  type CreateResult,
  type QuoteRequestFilter,
  type QuoteRequestGroupView,
  type QuoteRequestRepository,
} from '../../application/ports';
import { type PageRequest, type PageResult } from '../../application/shared/validation';
import { type Mission } from '../../domain/mission';
import { type QuoteRequest, type QuoteRequestGroup } from '../../domain/quote-request';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import { cursorFilter, pageArgs, toPage, type Tx, writeChanges } from './changes';
import { missionCreateColumns } from './mission.mapper';
import { lockOrganizationStanding } from './prisma-organization-standing.repository';
import { quoteColumns, REQUEST_INCLUDE, requestColumns, toRequest } from './quote-request.mapper';

const ids = new UuidV7Generator();

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const toGroup = (row: GroupRow): QuoteRequestGroup => ({
  id: row.id,
  customerId: row.customerId,
  placeType: row.placeType,
  commune: row.commune,
  createdAt: row.createdAt,
});

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

  async createGroup(
    group: QuoteRequestGroup,
    requests: QuoteRequest[],
    idempotencyKey: string,
    changes: Changes,
  ): Promise<CreateResult<QuoteRequestGroupView>> {
    // INSERT … ON CONFLICT DO NOTHING sur (client, clé) : de deux appels simultanés, un seul crée
    // le groupe ; ses demandes, événements et traces sont écrits dans la même transaction.
    const created = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.quoteRequestGroup.createMany({
        data: [
          {
            id: group.id,
            customerId: group.customerId,
            idempotencyKey,
            placeType: group.placeType,
            commune: group.commune,
            createdAt: group.createdAt,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return false;
      await tx.quoteRequest.createMany({
        data: requests.map((request, index) => ({
          id: request.id,
          customerId: request.customerId,
          idempotencyKey: `group:${group.id}:${index}`,
          createdAt: request.createdAt,
          ...requestColumns(request),
        })),
      });
      await writeChanges(tx, changes, () => ids.next());
      return true;
    });
    const stored = await this.findGroupByIdempotencyKey(group.customerId, idempotencyKey);
    return { created, value: stored! };
  }

  async findGroupByIdempotencyKey(
    customerId: string,
    idempotencyKey: string,
  ): Promise<QuoteRequestGroupView | null> {
    const row = await this.prisma.quoteRequestGroup.findUnique({
      where: { customerId_idempotencyKey: { customerId, idempotencyKey } },
    });
    return row ? this.groupView(row) : null;
  }

  async findGroup(groupId: string): Promise<QuoteRequestGroupView | null> {
    const row = await this.prisma.quoteRequestGroup.findUnique({ where: { id: groupId } });
    return row ? this.groupView(row) : null;
  }

  async groupSizes(groupIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await this.prisma.quoteRequest.groupBy({
      by: ['groupId'],
      where: { groupId: { in: [...groupIds] } },
      _count: { _all: true },
    });
    return new Map(rows.flatMap((row) => (row.groupId ? [[row.groupId, row._count._all] as const] : [])));
  }

  /**
   * Demandes du groupe dans l'ordre des prestations envoyées : clé « group:<id>:<rang> », rang
   * d'un seul chiffre (10 prestations au plus).
   */
  private async groupView(row: GroupRow): Promise<QuoteRequestGroupView> {
    const requests = await this.prisma.quoteRequest.findMany({
      where: { groupId: row.id },
      include: REQUEST_INCLUDE,
      orderBy: { idempotencyKey: 'asc' },
    });
    return { group: toGroup(row), requests: requests.map(toRequest) };
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
      where: {
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.communeCode ? { communeCode: filter.communeCode } : {}),
        ...(filter.customerKind ? { customerKind: filter.customerKind } : {}),
        ...(filter.groupId ? { groupId: filter.groupId } : {}),
        ...(filter.placeType ? { placeType: filter.placeType } : {}),
        ...(filter.serviceCode ? { serviceCode: filter.serviceCode } : {}),
        ...cursorFilter(page),
      },
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
        // Même verrou que l'enregistrement de l'état de l'organisation (ADR-030) : une suspension
        // enregistrée avant est vue ici, une suspension enregistrée après verra cette mission.
        if (mission.organizationId && (await lockOrganizationStanding(tx, mission.organizationId))) {
          return { status: 'organization_suspended' as const };
        }
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
