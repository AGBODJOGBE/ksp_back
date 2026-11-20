import {
  type AutoPlanningSettings,
  type ProposalRecord,
  type SessionScope,
} from '../../../application/auto-planning/auto-planning.ports';
import { type AgentRecord } from '../../../application/agents/agent.ports';
import { type TargetRecord } from '../../../application/planning/planning.ports';
import { type Page, type PageRequest } from '../../../application/shared/input';
import { type PlanningMode } from '../../../domain/auto-planning/modes';
import { type ProgramHistory, type SessionTally } from '../../../domain/auto-planning/score';
import { isInForce } from '../../../domain/planning/assignment-status';
import { compareIds } from '../../../domain/planning/order';
import { agentInclude, isUuid, toAgentRecord, uuids } from '../agents/agent-rows';
import { type Tx } from '../changes';
import { findAssignments, IN_FORCE, loadTargets } from '../planning/planning-rows';

/**
 * Lectures de la planification automatique (lot G) sur un client Prisma : celui du service, ou
 * celui d'une transaction pour relire sous le verrou de l'agenda.
 */

export async function autoPlanningSettings(client: Tx): Promise<AutoPlanningSettings> {
  const row = await client.cleaningSettings.findUniqueOrThrow({ where: { id: 1 } });
  return {
    defaultMode: row.defaultPlanningMode,
    horizonDays: row.planningHorizonDays,
    weights: {
      continuity: row.scoreWeightContinuity,
      proximity: row.scoreWeightProximity,
      balance: row.scoreWeightBalance,
      rating: row.scoreWeightRating,
    },
  };
}

export async function zoneModes(client: Tx): Promise<Record<string, PlanningMode | null>> {
  const zones = await client.zone.findMany({ select: { communeKey: true, planningMode: true } });
  return Object.fromEntries(zones.map((zone) => [zone.communeKey, zone.planningMode]));
}

export async function programExists(client: Tx, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return (await client.program.count({ where: { id } })) === 1;
}

/** Séances « à affecter » dont le début tombe dans la période, dans l'ordre chronologique. */
export async function sessionsToAssign(client: Tx, scope: SessionScope, now: Date): Promise<TargetRecord[]> {
  if (scope.programId !== null && !isUuid(scope.programId)) return [];
  const rows = await client.session.findMany({
    where: {
      status: 'to_assign',
      scheduledStart: { gte: scope.window.start, lt: scope.window.end },
      ...(scope.zoneKey ? { communeKey: scope.zoneKey } : {}),
      ...(scope.programId ? { programId: scope.programId } : {}),
    },
    select: { id: true },
  });
  const targets = await loadTargets(
    client,
    rows.map((r) => r.id),
    [],
    now,
  );
  return targets.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || compareIds(a.target.id, b.target.id),
  );
}

export async function activeAgents(client: Tx, now: Date): Promise<AgentRecord[]> {
  const rows = await client.agent.findMany({
    where: { status: 'active' },
    include: agentInclude(now),
    orderBy: { id: 'asc' },
  });
  return rows.map(toAgentRecord);
}

const emptyTally = (): { sessions: Set<string>; byAgent: Record<string, number> } => ({
  sessions: new Set(),
  byAgent: {},
});

function tally(rows: readonly { agentId: string; sessionId: string }[]): SessionTally {
  const value = emptyTally();
  for (const row of rows) {
    value.sessions.add(row.sessionId);
    value.byAgent[row.agentId] = (value.byAgent[row.agentId] ?? 0) + 1;
  }
  return { sessions: value.sessions.size, byAgent: value.byAgent };
}

/**
 * Historique des programmes (continuité, R-PL-03) : séances réalisées et agents confirmés qui les
 * ont faites ; affectations en vigueur sur les séances à venir (à affecter ou planifiées).
 */
export async function programHistories(
  client: Tx,
  programIds: readonly string[],
  now: Date,
): Promise<Map<string, ProgramHistory>> {
  const ids = uuids(programIds);
  const result = new Map<string, ProgramHistory>();
  if (!ids.length) return result;
  const [completedSessions, assignments] = await Promise.all([
    client.session.groupBy({
      by: ['programId'],
      where: { programId: { in: ids }, status: 'completed' },
      _count: { _all: true },
    }),
    client.assignment.findMany({
      where: {
        targetKind: 'session',
        OR: [
          { status: 'confirmed', session: { programId: { in: ids }, status: 'completed' } },
          {
            status: { in: IN_FORCE },
            session: { programId: { in: ids }, status: { in: ['to_assign', 'assigned'] } },
          },
        ],
      },
      select: {
        agentId: true,
        sessionId: true,
        status: true,
        responseDueAt: true,
        session: { select: { programId: true, status: true } },
      },
    }),
  ]);
  for (const programId of ids) {
    const mine = assignments.filter((a) => a.session?.programId === programId);
    const completed = mine.filter((a) => a.session?.status === 'completed');
    const inForce = mine.filter(
      (a) =>
        a.session?.status !== 'completed' &&
        isInForce({ status: a.status, respondBefore: a.responseDueAt }, now),
    );
    const completedCount = completedSessions.find((g) => g.programId === programId)?._count._all ?? 0;
    if (!completedCount && !inForce.length) continue;
    const done = tally(completed.map((a) => ({ agentId: a.agentId, sessionId: a.sessionId! })));
    result.set(programId, {
      completed: { sessions: completedCount, byAgent: done.byAgent },
      inForce: tally(inForce.map((a) => ({ agentId: a.agentId, sessionId: a.sessionId! }))),
    });
  }
  return result;
}

/** Propositions en vigueur (statut « proposed »), les plus proches d'abord ; curseur : décalage. */
export async function proposals(
  client: Tx,
  filter: { zoneKey: string | null },
  page: PageRequest,
): Promise<Page<ProposalRecord>> {
  const where = {
    status: 'proposed' as const,
    ...(filter.zoneKey ? { session: { communeKey: filter.zoneKey } } : {}),
  };
  const offset = page.cursor ? Number(page.cursor) : 0;
  const [total, records] = await Promise.all([
    client.assignment.count({ where }),
    findAssignments(client, where),
  ]);
  const sorted = records.sort((a, b) => a.start.getTime() - b.start.getTime() || compareIds(a.id, b.id));
  const slice = sorted.slice(offset, offset + page.limit);
  const agents = await client.agent.findMany({
    where: { id: { in: [...new Set(slice.map((a) => a.agentId))] } },
    select: { id: true, displayName: true },
  });
  const sessions = await client.session.findMany({
    where: { id: { in: slice.flatMap((a) => (a.target.kind === 'session' ? [a.target.id] : [])) } },
    select: { id: true, communeKey: true },
  });
  return {
    items: slice.map((record) => ({
      ...record,
      agentName: agents.find((a) => a.id === record.agentId)?.displayName ?? '',
      communeKey: sessions.find((s) => s.id === record.target.id)?.communeKey ?? '',
    })),
    nextCursor: offset + page.limit < total ? String(offset + page.limit) : null,
    total,
  };
}
