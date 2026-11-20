import { type AgentFilter } from '../../../application/agents/agent.ports';
import {
  type AssignmentFilter,
  type IdempotencyKeyRef,
  type PlanningFilter,
  type PlanningRepository,
  type PlanningTx,
} from '../../../application/planning/planning.ports';
import { type Clock, type IdGenerator } from '../../../application/ports';
import { type PageRequest } from '../../../application/shared/input';
import { type PrismaService } from '../../prisma/prisma.service';
import { agentStats, listAgents, listTeams } from '../agents/agent-lists';
import { isUuid } from '../agents/agent-rows';
import { type Tx } from '../changes';
import { agentAssignments, planning, unassigned } from './planning-lists';
import { PrismaPlanningReader } from './prisma-planning.reader';
import { PrismaPlanningTx } from './prisma-planning.tx';

/**
 * Dépôt des agents et de la planification (lot D). Une transaction attend au plus 10 s son tour et
 * dure au plus 20 s : le verrou de l'agenda (lockAgents) fait patienter un second superviseur
 * jusqu'à la fin de la première affectation, qu'il relit ensuite.
 */
export class PrismaPlanningRepository extends PrismaPlanningReader implements PlanningRepository {
  constructor(
    private readonly prisma: PrismaService,
    clock: Clock,
    private readonly ids: IdGenerator,
  ) {
    super(prisma as unknown as Tx, clock);
  }

  transaction<T>(work: (tx: PlanningTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => work(new PrismaPlanningTx(tx, this.clock, this.ids)), {
      maxWait: 10_000,
      timeout: 20_000,
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

  listAgents(filter: AgentFilter, page: PageRequest) {
    return listAgents(this.client, filter, page, this.clock.now());
  }

  agentStats(agentIds: readonly string[], now: Date) {
    return agentStats(this.client, agentIds, now);
  }

  listTeams(filter: { active: boolean | null }, page: PageRequest) {
    return listTeams(this.client, filter, page);
  }

  async missingSkills(codes: readonly string[]): Promise<string[]> {
    const found = await this.prisma.skill.findMany({ where: { code: { in: [...codes] }, active: true } });
    return codes.filter((code) => !found.some((skill) => skill.code === code));
  }

  async missingZones(keys: readonly string[]): Promise<string[]> {
    const found = await this.prisma.zone.findMany({ where: { communeKey: { in: [...keys] }, active: true } });
    return keys.filter((key) => !found.some((zone) => zone.communeKey === key));
  }

  agentAssignments(agentId: string, filter: AssignmentFilter, page: PageRequest) {
    return agentAssignments(this.client, agentId, filter, page, this.clock.now());
  }

  planning(filter: PlanningFilter) {
    return planning(this.client, filter, this.clock.now());
  }

  unassigned(filter: { zoneKey: string | null; now: Date }, page: PageRequest) {
    return unassigned(this.client, filter, page);
  }
}
