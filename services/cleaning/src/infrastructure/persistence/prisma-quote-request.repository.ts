import { Injectable } from '@nestjs/common';
import { Prisma, type QuoteRequestGroup as GroupRow } from '../../../prisma/generated';
import {
  type Changes,
  type CreateResult,
  type GroupOperation,
  type GroupOperationRecord,
  type GroupWrite,
  type GroupWriteOutcome,
  type VisitEntry,
  type VisitFilter,
  type ZoneActivity,
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
import { outcomeFromJson, recordGroupOperation } from './group-operations';
import { updateMission } from './prisma-mission.repository';
import { TERMINAL_MISSION_STATUSES } from '../../domain/mission';
import { quoteColumns, REQUEST_INCLUDE, requestColumns, toRequest } from './quote-request.mapper';

const ids = new UuidV7Generator();

/** Annule la transaction d'une opération de groupe : abandon sans erreur pour l'appelant. */
class GroupAbort extends Error {
  constructor(readonly outcome: GroupWriteOutcome) {
    super(outcome);
  }
}

/** États d'une demande clôturée : sa position peut être purgée (ADR-035). */
const CLOSED_REQUEST_STATUSES = ['accepted', 'declined', 'rejected', 'expired', 'cancelled'];

/**
 * Effacement de la position (ADR-035) : coordonnées, précision, repère, adresse géocodée ; l'adresse
 * qui n'est que le repère est vidée. La version augmente : une écriture concurrente est refusée.
 */
const ERASE_REQUEST_SET =
  'latitude = NULL, longitude = NULL, location_accuracy_m = NULL, geocoded_address = NULL, ' +
  "address = CASE WHEN landmark IS NOT NULL AND address = landmark THEN '' ELSE address END, " +
  'landmark = NULL, version = version + 1';
const ERASE_MISSION_SET =
  'latitude = NULL, longitude = NULL, location_accuracy_m = NULL, ' +
  "address = CASE WHEN landmark IS NOT NULL AND address = landmark THEN '' ELSE address END, " +
  'landmark = NULL, version = version + 1';
const HAS_REQUEST_PLACE = '(latitude IS NOT NULL OR landmark IS NOT NULL OR geocoded_address IS NOT NULL)';
const HAS_MISSION_PLACE = '(latitude IS NOT NULL OR landmark IS NOT NULL)';

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
        ...(filter.organizationId !== undefined ? { organizationId: filter.organizationId } : {}),
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
    // Chaque demande seule et chaque groupe comptent pour 1 (ADR-035).
    const rows = await this.prisma.quoteRequest.findMany({
      where: {
        customerId,
        OR: [
          { status: { in: ['received', 'visit_scheduled'] } },
          { status: 'quote_sent', quotes: { some: { validUntil: { gt: now } } } },
        ],
      },
      select: { groupId: true },
    });
    const groups = new Set(rows.flatMap((row) => (row.groupId ? [row.groupId] : [])));
    return rows.filter((row) => !row.groupId).length + groups.size;
  }

  async openForCustomer(customerId: string, now: Date): Promise<{ id: string }[]> {
    return this.prisma.quoteRequest.findMany({
      where: {
        customerId,
        OR: [
          { status: { in: ['received', 'visit_scheduled'] } },
          { status: 'quote_sent', quotes: { some: { validUntil: { gt: now } } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  }

  async findGroupOperation(
    actorId: string,
    operation: GroupOperation,
    idempotencyKey: string,
  ): Promise<GroupOperationRecord | null> {
    const row = await this.prisma.requestGroupOperation.findUnique({
      where: { actorId_operation_idempotencyKey: { actorId, operation, idempotencyKey } },
    });
    return row ? { actorId, operation, idempotencyKey, outcome: outcomeFromJson(row.outcome) } : null;
  }

  async saveGroup(write: GroupWrite): Promise<GroupWriteOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (write.organizationId && (await lockOrganizationStanding(tx, write.organizationId))) {
          throw new GroupAbort('organization_suspended');
        }
        if (write.operation && !(await recordGroupOperation(tx, write.operation))) {
          throw new GroupAbort('replayed');
        }
        for (const request of write.requests) {
          if (!(await this.update(tx, request))) throw new GroupAbort('conflict');
        }
        for (const mission of write.missions ?? []) {
          if (!(await updateMission(tx, mission))) throw new GroupAbort('conflict');
        }
        for (const { mission, acceptanceKey } of write.newMissions ?? []) {
          await tx.mission.create({ data: missionCreateColumns(mission, acceptanceKey) });
        }
        await writeChanges(tx, write.changes, () => ids.next());
        return 'saved' as const;
      });
    } catch (error) {
      if (error instanceof GroupAbort) return error.outcome;
      // Acceptation concurrente d'une des demandes : missions.request_id tranche.
      if (isUniqueViolation(error)) return 'conflict';
      throw error;
    }
  }

  async listVisits(filter: VisitFilter, page: PageRequest): Promise<PageResult<VisitEntry>> {
    const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (filter.agentId) conditions.push(Prisma.sql`v.agent_id = ${filter.agentId}::uuid`);
    if (filter.status) conditions.push(Prisma.sql`v.status = ${filter.status}`);
    if (filter.from) conditions.push(Prisma.sql`v.scheduled_at >= ${filter.from}`);
    if (filter.to) conditions.push(Prisma.sql`v.scheduled_at < ${filter.to}`);
    if (filter.groupId) conditions.push(Prisma.sql`r.group_id = ${filter.groupId}::uuid`);
    const key = Prisma.sql`COALESCE(v.group_visit_id, v.id)`;
    if (page.cursor) conditions.push(Prisma.sql`${key} < ${page.cursor}::uuid`);
    const keys = await this.prisma.$queryRaw<{ key: string }[]>`
      SELECT ${key} AS key FROM site_visits v JOIN quote_requests r ON r.id = v.request_id
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY ${key} ORDER BY ${key} DESC LIMIT ${page.limit + 1}`;
    const { items, nextCursor } = toPage(
      keys.map((row) => ({ id: row.key })),
      page.limit,
    );
    const visitIds = items.map((item) => item.id);
    const rows = visitIds.length
      ? await this.prisma.quoteRequest.findMany({
          where: {
            visit: { OR: [{ id: { in: visitIds } }, { groupVisitId: { in: visitIds } }] },
            ...(filter.groupId ? { groupId: filter.groupId } : {}),
          },
          include: REQUEST_INCLUDE,
          orderBy: { idempotencyKey: 'asc' },
        })
      : [];
    const requests = rows.map(toRequest);
    return {
      items: visitIds.map((id) => ({
        id,
        requests: requests.filter((request) => (request.visit?.groupVisitId ?? request.visit?.id) === id),
      })),
      nextCursor,
    };
  }

  async zoneActivity(now: Date): Promise<Map<string, ZoneActivity>> {
    const [requests, missions] = await Promise.all([
      this.prisma.quoteRequest.groupBy({
        by: ['communeCode'],
        where: {
          OR: [
            { status: { in: ['received', 'visit_scheduled'] } },
            { status: 'quote_sent', quotes: { some: { validUntil: { gt: now } } } },
          ],
        },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ code: string; count: number }[]>`
        SELECT r.commune_code AS code, COUNT(*)::int AS count
        FROM missions m JOIN quote_requests r ON r.id = m.request_id
        WHERE m.status <> ALL(${[...TERMINAL_MISSION_STATUSES]}::text[])
        GROUP BY r.commune_code`,
    ]);
    const activity = new Map<string, ZoneActivity>();
    for (const row of requests) {
      activity.set(row.communeCode, { openRequests: row._count._all, activeMissions: 0 });
    }
    for (const row of missions) {
      const current = activity.get(row.code) ?? { openRequests: 0, activeMissions: 0 };
      activity.set(row.code, { ...current, activeMissions: Number(row.count) });
    }
    return activity;
  }

  async purgeLocations(cutoff: Date, batchSize: number): Promise<{ requests: number; missions: number }> {
    let requests = 0;
    let missions = 0;
    for (;;) {
      const count = await this.prisma.$executeRawUnsafe(
        `UPDATE quote_requests SET ${ERASE_REQUEST_SET} WHERE id IN (` +
          `SELECT id FROM quote_requests WHERE ${HAS_REQUEST_PLACE} AND updated_at < $1 AND (` +
          `status = ANY($2::text[]) OR (status = 'quote_sent' AND NOT EXISTS (` +
          `SELECT 1 FROM quotes q WHERE q.request_id = quote_requests.id AND q.valid_until >= $1))) ` +
          `LIMIT $3 FOR UPDATE SKIP LOCKED)`,
        cutoff,
        CLOSED_REQUEST_STATUSES,
        batchSize,
      );
      requests += count;
      if (count < batchSize) break;
    }
    for (;;) {
      const count = await this.prisma.$executeRawUnsafe(
        `UPDATE missions SET ${ERASE_MISSION_SET} WHERE id IN (` +
          `SELECT id FROM missions WHERE ${HAS_MISSION_PLACE} AND updated_at < $1 ` +
          `AND status = ANY($2::text[]) LIMIT $3 FOR UPDATE SKIP LOCKED)`,
        cutoff,
        [...TERMINAL_MISSION_STATUSES],
        batchSize,
      );
      missions += count;
      if (count < batchSize) break;
    }
    return { requests, missions };
  }

  async eraseCustomerLocations(
    customerId: string,
    inbox: { eventId: string; consumer: string },
  ): Promise<'processed' | 'duplicate'> {
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRawUnsafe(
        'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
          'ON CONFLICT DO NOTHING',
        inbox.eventId,
        inbox.consumer,
      );
      if (inserted === 0) return 'duplicate' as const;
      await tx.$executeRawUnsafe(
        `UPDATE quote_requests SET ${ERASE_REQUEST_SET} WHERE customer_id = $1::uuid AND ${HAS_REQUEST_PLACE}`,
        customerId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE missions SET ${ERASE_MISSION_SET} WHERE customer_id = $1::uuid AND ${HAS_MISSION_PLACE}`,
        customerId,
      );
      return 'processed' as const;
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
        groupVisitId: request.visit.groupVisitId ?? null,
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
