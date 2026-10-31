import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import { type Changes, type MissionFilter, type MissionRepository } from '../../application/ports';
import { type PageRequest, type PageResult } from '../../application/shared/validation';
import {
  ACTIVE_INTERVENTION_STATUSES,
  type Intervention,
  type Mission,
  type MissionStatus,
  TERMINAL_MISSION_STATUSES,
} from '../../domain/mission';
import { type BusyPeriod } from '../../domain/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import { cursorFilter, json, pageArgs, toPage, type Tx, writeChanges } from './changes';
import { interventionColumns, MISSION_INCLUDE, suspensionColumns, toMission } from './mission.mapper';

const ids = new UuidV7Generator();

/** Annule la transaction d'un événement quand la mission a changé depuis sa lecture. */
class ConcurrentMissionUpdate extends Error {}

@Injectable()
export class PrismaMissionRepository implements MissionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Mission | null> {
    const row = await this.prisma.mission.findUnique({ where: { id }, include: MISSION_INCLUDE });
    return row ? toMission(row) : null;
  }

  async findByInterventionId(interventionId: string): Promise<Mission | null> {
    const row = await this.prisma.intervention.findUnique({
      where: { id: interventionId },
      select: { missionId: true },
    });
    return row ? this.findById(row.missionId) : null;
  }

  async list(filter: MissionFilter, page: PageRequest): Promise<PageResult<Mission>> {
    const rows = await this.prisma.mission.findMany({
      where: {
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.agentId ? { interventions: { some: { agentIds: { has: filter.agentId } } } } : {}),
        ...cursorFilter(page),
      },
      include: MISSION_INCLUDE,
      ...pageArgs(page),
    });
    const result = toPage(rows, page.limit);
    return { items: result.items.map(toMission), nextCursor: result.nextCursor };
  }

  async save(mission: Mission, changes: Changes): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.update(tx, mission))) return false;
      await writeChanges(tx, changes, () => ids.next());
      return true;
    });
  }

  async saveFromEvent(
    mission: Mission,
    changes: Changes,
    inbox: { eventId: string; consumer: string },
  ): Promise<'saved' | 'duplicate' | 'conflict'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.$executeRawUnsafe(
          'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
            'ON CONFLICT DO NOTHING',
          inbox.eventId,
          inbox.consumer,
        );
        if (inserted === 0) return 'duplicate' as const;
        // Version changée : annule aussi la marque de l'inbox (le message sera retraité).
        if (!(await this.update(tx, mission))) throw new ConcurrentMissionUpdate();
        await writeChanges(tx, changes, () => ids.next());
        return 'saved' as const;
      });
    } catch (error) {
      if (error instanceof ConcurrentMissionUpdate) return 'conflict';
      throw error;
    }
  }

  async scheduleIntervention(
    mission: Mission,
    intervention: Intervention,
    conflicts: (busy: BusyPeriod[]) => string[],
    changes: Changes,
  ): Promise<{ conflicts: string[]; saved: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // Verrou sur les agents concernés : deux planifications simultanées ne peuvent pas les réserver deux fois.
      await tx.$queryRawUnsafe(
        'SELECT user_id FROM agents WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE',
        intervention.agentIds,
      );
      const found = conflicts(await this.busyPeriods(tx, intervention.agentIds, intervention.id));
      if (found.length) return { conflicts: found, saved: false };
      if (!(await this.update(tx, mission))) return { conflicts: [], saved: false };
      await writeChanges(tx, changes, () => ids.next());
      return { conflicts: [], saved: true };
    });
  }

  async pendingForCustomer(customerId: string): Promise<{ id: string; status: MissionStatus }[]> {
    const rows = await this.prisma.mission.findMany({
      where: { customerId, status: { notIn: [...TERMINAL_MISSION_STATUSES] } },
      select: { id: true, status: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => ({ id: row.id, status: row.status as MissionStatus }));
  }

  async saveWithAgenda(
    agentIds: string[],
    plan: (busy: BusyPeriod[]) => { mission: Mission; changes: Changes },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Même verrou que la planification manuelle : aucune double réservation possible.
      await tx.$queryRawUnsafe(
        'SELECT user_id FROM agents WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE',
        agentIds,
      );
      const busy = agentIds.length ? await this.busyPeriods(tx, agentIds, null) : [];
      const { mission, changes } = plan(busy.filter((period) => agentIds.includes(period.agentId)));
      if (!(await this.update(tx, mission))) return false;
      await writeChanges(tx, changes, () => ids.next());
      return true;
    });
  }

  async listIndividualRecurring(): Promise<Mission[]> {
    const rows = await this.prisma.mission.findMany({
      where: {
        organizationId: null,
        recurrence: { not: Prisma.DbNull },
        status: { notIn: [...TERMINAL_MISSION_STATUSES] },
      },
      include: MISSION_INCLUDE,
      orderBy: { id: 'asc' },
    });
    return rows.map(toMission);
  }

  async listActiveForOrganization(organizationId: string): Promise<Mission[]> {
    const rows = await this.prisma.mission.findMany({
      where: { organizationId, status: { notIn: [...TERMINAL_MISSION_STATUSES] } },
      include: MISSION_INCLUDE,
      orderBy: { id: 'asc' },
    });
    return rows.map(toMission);
  }

  /** Passages actifs et indisponibilités des agents donnés, hors un passage éventuel. */
  private async busyPeriods(tx: Tx, agentIds: string[], excludedId: string | null): Promise<BusyPeriod[]> {
    const [interventions, unavailabilities] = await Promise.all([
      tx.intervention.findMany({
        where: {
          ...(excludedId ? { id: { not: excludedId } } : {}),
          status: { in: [...ACTIVE_INTERVENTION_STATUSES] },
          agentIds: { hasSome: agentIds },
        },
        select: { agentIds: true, scheduledStart: true, scheduledEnd: true },
      }),
      tx.agentUnavailability.findMany({
        where: { agentId: { in: agentIds } },
        select: { agentId: true, startsAt: true, endsAt: true },
      }),
    ]);
    return [
      ...interventions.flatMap((row) =>
        row.agentIds.map((agentId) => ({
          agentId,
          slot: { start: row.scheduledStart, end: row.scheduledEnd },
        })),
      ),
      ...unavailabilities.map((row) => ({
        agentId: row.agentId,
        slot: { start: row.startsAt, end: row.endsAt },
      })),
    ];
  }

  /** Mission, passages et nouveaux paiements, conditionnés à la version lue. */
  private async update(tx: Tx, mission: Mission): Promise<boolean> {
    const { count } = await tx.mission.updateMany({
      where: { id: mission.id, version: mission.version },
      data: {
        status: mission.status,
        cancellationReason: mission.cancellationReason,
        ...suspensionColumns(mission),
        updatedAt: mission.updatedAt,
        version: { increment: 1 },
      },
    });
    if (count === 0) return false;
    for (const intervention of mission.interventions) {
      const columns = interventionColumns(mission.id, intervention);
      await tx.intervention.upsert({
        where: { id: intervention.id },
        create: columns,
        update: { ...columns, checklist: json(intervention.checklist) },
      });
    }
    // Un paiement enregistré n'est jamais modifié : seuls les nouveaux sont insérés.
    await tx.missionPayment.createMany({
      data: mission.payment.payments.map((payment) => ({ ...payment, missionId: mission.id })),
      skipDuplicates: true,
    });
    return true;
  }
}
