import { type Prisma } from '../../../../prisma/generated';
import {
  type AgentAssignmentRecord,
  type AssignmentFilter,
  type PlanningFilter,
  type TargetRecord,
} from '../../../application/planning/planning.ports';
import { type Page, type PageRequest } from '../../../application/shared/input';
import { uuids } from '../agents/agent-rows';
import { type Tx } from '../changes';
import { IN_FORCE, loadTargets, toAssignmentRecord } from './planning-rows';

/** Listes de la planification : mon planning, planning du back-office, colonne « à affecter ». */

const offset = (page: PageRequest) => (page.cursor ? Number(page.cursor) : 0);

function nextCursor(page: PageRequest, total: number): string | null {
  const next = offset(page) + page.limit;
  return next < total ? String(next) : null;
}

/** Filtre sur le statut effectif : une attente échue est « expirée » (15.2). */
function statusWhere(status: AssignmentFilter['status'], now: Date): Prisma.AssignmentWhereInput {
  if (status === 'expired') {
    return { OR: [{ status: 'expired' }, { status: 'pending_confirmation', responseDueAt: { lt: now } }] };
  }
  if (status === 'pending_confirmation') return { status, responseDueAt: { gte: now } };
  return status ? { status } : {};
}

export async function agentAssignments(
  client: Tx,
  agentId: string,
  filter: AssignmentFilter,
  page: PageRequest,
  now: Date,
): Promise<Page<AgentAssignmentRecord>> {
  if (!uuids([agentId]).length) return { items: [], nextCursor: null, total: 0 };
  const where: Prisma.AssignmentWhereInput = {
    agentId,
    occupiedUntil: { gt: filter.window.start },
    occupiedFrom: { lt: filter.window.end },
    ...statusWhere(filter.status, now),
  };
  const [rows, total] = await Promise.all([
    client.assignment.findMany({
      where,
      include: {
        session: {
          select: { scheduledStart: true, scheduledEnd: true, program: { select: { placeId: true } } },
        },
        visit: {
          select: { scheduledStart: true, scheduledEnd: true, request: { select: { placeId: true } } },
        },
      },
      orderBy: [{ occupiedFrom: 'asc' }, { id: 'asc' }],
      skip: offset(page),
      take: page.limit,
    }),
    client.assignment.count({ where }),
  ]);
  const records = rows.map(toAssignmentRecord);
  const targets = await loadTargets(
    client,
    records.filter((r) => r.target.kind === 'session').map((r) => r.target.id),
    records.filter((r) => r.target.kind === 'visit').map((r) => r.target.id),
    now,
  );
  return {
    items: records.map((record) => {
      const target = targets.find(
        (t) => t.target.kind === record.target.kind && t.target.id === record.target.id,
      );
      return {
        ...record,
        targetStatus: target?.status ?? '',
        placeTypeName: target?.placeTypeName ?? '',
        communeName: target?.communeName ?? '',
      };
    }),
    nextCursor: nextCursor(page, total),
    total,
  };
}

/** Affectations en vigueur de l'agent ou des membres de l'équipe filtrés. */
async function staffWhere(
  client: Tx,
  filter: PlanningFilter,
): Promise<Prisma.AssignmentListRelationFilter | null> {
  const agentIds: string[] = [];
  if (filter.agentId) agentIds.push(filter.agentId);
  if (filter.teamId) {
    const members = uuids([filter.teamId]).length
      ? await client.teamMember.findMany({ where: { teamId: filter.teamId }, select: { agentId: true } })
      : [];
    agentIds.push(...members.map((m) => m.agentId));
  }
  if (!filter.agentId && !filter.teamId) return null;
  return { some: { agentId: { in: uuids(agentIds) }, status: { in: IN_FORCE } } };
}

export async function planning(client: Tx, filter: PlanningFilter, now: Date): Promise<TargetRecord[]> {
  const staff = await staffWhere(client, filter);
  const period = { scheduledStart: { lt: filter.window.end }, scheduledEnd: { gt: filter.window.start } };
  const programId = filter.programId ? (uuids([filter.programId])[0] ?? null) : null;
  if (filter.programId && !programId) return [];
  const [sessions, visits] = await Promise.all([
    client.session.findMany({
      where: {
        ...period,
        ...(filter.zoneKey ? { communeKey: filter.zoneKey } : {}),
        ...(programId ? { programId } : {}),
        ...(staff ? { assignments: staff } : {}),
      },
      select: { id: true },
    }),
    programId
      ? []
      : client.visit.findMany({
          where: {
            ...period,
            ...(filter.zoneKey ? { request: { communeKey: filter.zoneKey } } : {}),
            ...(staff ? { assignments: staff } : {}),
          },
          select: { id: true },
        }),
  ]);
  const targets = await loadTargets(
    client,
    sessions.map((s) => s.id),
    visits.map((v) => v.id),
    now,
  );
  return targets.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Colonne « à affecter » (R-PL-06) : séances à affecter ou sans équipe complète, visites planifiées
 * sans agent, à venir ou en cours ; les plus proches d'abord.
 */
export async function unassigned(
  client: Tx,
  filter: { zoneKey: string | null; now: Date },
  page: PageRequest,
): Promise<Page<TargetRecord>> {
  const [sessions, visits] = await Promise.all([
    client.session.findMany({
      where: {
        status: { in: ['to_assign', 'assigned'] },
        scheduledEnd: { gt: filter.now },
        ...(filter.zoneKey ? { communeKey: filter.zoneKey } : {}),
      },
      select: { id: true },
    }),
    client.visit.findMany({
      where: {
        status: 'scheduled',
        scheduledEnd: { gt: filter.now },
        assignments: { none: { status: { in: IN_FORCE } } },
        ...(filter.zoneKey ? { request: { communeKey: filter.zoneKey } } : {}),
      },
      select: { id: true },
    }),
  ]);
  const targets = (
    await loadTargets(
      client,
      sessions.map((s) => s.id),
      visits.map((v) => v.id),
      filter.now,
    )
  )
    .filter((t) => t.status === 'to_assign' || t.assignments.length < (t.expectedTeamSize ?? 1))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || a.target.id.localeCompare(b.target.id));
  const start = offset(page);
  return {
    items: targets.slice(start, start + page.limit),
    nextCursor: nextCursor(page, targets.length),
    total: targets.length,
  };
}
