import {
  type AutoPlanningRepository,
  type AutoPlanningTx,
  type ProposalApprovalRow,
  type SessionScope,
} from '../../../application/auto-planning/auto-planning.ports';
import { type IdempotencyKeyRef } from '../../../application/planning/planning.ports';
import { type Clock, type IdGenerator } from '../../../application/ports';
import { type PageRequest } from '../../../application/shared/input';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid } from '../agents/agent-rows';
import { type Tx } from '../changes';
import { PrismaPlanningReader } from '../planning/prisma-planning.reader';
import { isOverlapViolation, PrismaPlanningTx } from '../planning/prisma-planning.tx';
import { ScheduleOverlapError } from '../../../application/planning/planning.ports';
import {
  activeAgents,
  autoPlanningSettings,
  programExists,
  programHistories,
  proposals,
  sessionsToAssign,
  zoneModes,
} from './auto-planning-rows';

/**
 * Clé du verrou consultatif du passage régulier (valeur arbitraire, propre à cleaning) : deux
 * répliques ne planifient pas en même temps.
 */
export const AUTO_PLANNING_LOCK = 54_054_038;

/** Lectures de l'automatique, communes au dépôt et à la transaction. */
function autoReads(client: Tx, clock: Clock) {
  return {
    autoPlanningSettings: () => autoPlanningSettings(client),
    zoneModes: () => zoneModes(client),
    programExists: (id: string) => programExists(client, id),
    sessionsToAssign: (scope: SessionScope) => sessionsToAssign(client, scope, clock.now()),
    activeAgents: () => activeAgents(client, clock.now()),
    programHistories: (ids: readonly string[]) => programHistories(client, ids, clock.now()),
  };
}

/** Transaction de l'automatique : celle de la planification, plus le verrou du passage et la validation. */
export class PrismaAutoPlanningTx extends PrismaPlanningTx implements AutoPlanningTx {
  private readonly reads: ReturnType<typeof autoReads>;

  constructor(client: Tx, clock: Clock, ids: IdGenerator) {
    super(client, clock, ids);
    this.reads = autoReads(client, clock);
  }

  autoPlanningSettings() {
    return this.reads.autoPlanningSettings();
  }
  zoneModes() {
    return this.reads.zoneModes();
  }
  programExists(id: string) {
    return this.reads.programExists(id);
  }
  sessionsToAssign(scope: SessionScope) {
    return this.reads.sessionsToAssign(scope);
  }
  activeAgents() {
    return this.reads.activeAgents();
  }
  programHistories(ids: readonly string[]) {
    return this.reads.programHistories(ids);
  }

  async tryRunLock(): Promise<boolean> {
    const rows = await this.client.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${AUTO_PLANNING_LOCK}::bigint) AS locked`;
    return rows[0]?.locked === true;
  }

  async approveProposal(row: ProposalApprovalRow): Promise<boolean> {
    try {
      const { count } = await this.client.assignment.updateMany({
        where: { id: row.id, status: 'proposed' },
        data: {
          status: row.status,
          responseDueAt: row.respondBefore,
          occupiedFrom: row.occupiedFrom,
          occupiedUntil: row.occupiedUntil,
          travelMinutes: row.travelMinutes,
          approvedBy: row.approvedBy,
          approvedAt: row.approvedAt,
        },
      });
      return count === 1;
    } catch (error) {
      if (isOverlapViolation(error)) throw new ScheduleOverlapError();
      throw error;
    }
  }
}

/** Dépôt de la planification automatique (lot G). */
export class PrismaAutoPlanningRepository extends PrismaPlanningReader implements AutoPlanningRepository {
  private readonly reads: ReturnType<typeof autoReads>;

  constructor(
    private readonly prisma: PrismaService,
    clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    super(prisma as unknown as Tx, clock);
    this.reads = autoReads(prisma as unknown as Tx, clock);
  }

  transaction<T>(work: (tx: AutoPlanningTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaAutoPlanningTx(tx, this.clock, this.ids)), {
      maxWait: 10_000,
      timeout: 60_000,
    });
  }

  async idempotency(ref: IdempotencyKeyRef) {
    if (!isUuid(ref.actorId)) return null;
    const row = await this.prisma.idempotencyRecord.findUnique({
      where: {
        actorId_operation_idempotencyKey: {
          actorId: ref.actorId,
          operation: ref.operation,
          idempotencyKey: ref.key,
        },
      },
    });
    return row ? { requestHash: row.requestHash, response: row.response } : null;
  }

  proposals(filter: { zoneKey: string | null }, page: PageRequest) {
    return proposals(this.client, filter, page);
  }

  autoPlanningSettings() {
    return this.reads.autoPlanningSettings();
  }
  zoneModes() {
    return this.reads.zoneModes();
  }
  programExists(id: string) {
    return this.reads.programExists(id);
  }
  sessionsToAssign(scope: SessionScope) {
    return this.reads.sessionsToAssign(scope);
  }
  activeAgents() {
    return this.reads.activeAgents();
  }
  programHistories(ids: readonly string[]) {
    return this.reads.programHistories(ids);
  }
}
