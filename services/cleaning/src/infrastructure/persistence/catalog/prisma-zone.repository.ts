import { type Prisma } from '../../../../prisma/generated';
import {
  type SaveMode,
  type Zone,
  type ZoneActivity,
  type ZoneRepository,
} from '../../../application/catalog/catalog.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import { type RequestStatus } from '../../../domain/requests/request-status';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid, transact } from './shared';

const toZone = (row: Prisma.ZoneGetPayload<object>): Zone => ({
  id: row.id,
  communeKey: row.communeKey,
  name: row.name,
  coefficientBps: row.coefficientBp,
  visitFeeSurcharge: row.visitFeeSurcharge,
  planningMode: row.planningMode,
  active: row.active,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

/** Statuts lus d'après l'heure (RV-14) : le domaine décide si la demande est encore ouverte. */
const MAYBE_OPEN: RequestStatus[] = [
  'awaiting_visit_fee',
  'visit_to_schedule',
  'visit_scheduled',
  'visit_missed',
  'visit_done',
  'quote_sent',
];

/** Zones desservies (partie 4) : une par commune, jamais supprimées. */
export class PrismaZoneRepository implements ZoneRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async listZones(): Promise<Zone[]> {
    return (await this.prisma.zone.findMany()).map(toZone);
  }

  async getZone(id: string): Promise<Zone | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.zone.findUnique({ where: { id } });
    return row && toZone(row);
  }

  async findByCommune(communeKey: string): Promise<Zone | null> {
    const row = await this.prisma.zone.findUnique({ where: { communeKey } });
    return row && toZone(row);
  }

  /** Une zone par commune : la commune déjà ouverte répond « code déjà utilisé ». */
  async saveZone(zone: Zone, mode: SaveMode, changes: Changes): Promise<void> {
    const data = {
      name: zone.name,
      coefficientBp: zone.coefficientBps,
      visitFeeSurcharge: zone.visitFeeSurcharge,
      planningMode: zone.planningMode,
      active: zone.active,
      updatedAt: zone.updatedAt,
      updatedBy: zone.updatedBy,
    };
    await transact(
      this.prisma,
      this.ids,
      changes,
      (tx) =>
        mode === 'create'
          ? tx.zone.create({
              data: { ...data, id: zone.id, communeKey: zone.communeKey, createdAt: zone.updatedAt },
            })
          : tx.zone.update({ where: { id: zone.id }, data }),
      ['commune_key', 'communeKey'],
    );
  }

  /**
   * Demandes peut-être ouvertes (avec la validité du devis envoyé et l'échéance des frais à payer)
   * et programmes ni terminés ni annulés, par commune.
   */
  async activityOf(communeKeys: readonly string[]): Promise<Map<string, ZoneActivity>> {
    const keys = [...communeKeys];
    const [requests, programs] = await Promise.all([
      this.prisma.cleaningRequest.findMany({
        where: { communeKey: { in: keys }, status: { in: MAYBE_OPEN } },
        select: {
          communeKey: true,
          status: true,
          quotes: { where: { status: 'sent' }, select: { validUntil: true } },
          visitFees: { where: { status: 'awaiting_payment' }, select: { dueAt: true } },
        },
      }),
      this.prisma.program.groupBy({
        by: ['communeKey'],
        where: { communeKey: { in: keys }, status: { notIn: ['completed', 'cancelled'] } },
        _count: { _all: true },
      }),
    ]);
    const activity = new Map<string, ZoneActivity>(
      keys.map((key) => [key, { requests: [], activePrograms: 0 }]),
    );
    for (const request of requests) {
      activity.get(request.communeKey)?.requests.push({
        status: request.status,
        sentQuoteValidUntil: request.quotes[0]?.validUntil ?? null,
        pendingVisitFeeDueAt: request.visitFees[0]?.dueAt ?? null,
      });
    }
    for (const group of programs) {
      const entry = activity.get(group.communeKey);
      if (entry) entry.activePrograms = group._count._all;
    }
    return activity;
  }
}
