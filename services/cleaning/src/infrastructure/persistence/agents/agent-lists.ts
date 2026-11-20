import { type Prisma } from '../../../../prisma/generated';
import {
  type AgentFilter,
  type AgentRecord,
  type AgentStatsRecord,
  type TeamRecord,
} from '../../../application/agents/agent.ports';
import { type Page, type PageRequest } from '../../../application/shared/input';
import { isoWeekMonday, localDayStart, localPosition } from '../../../domain/planning/time';
import { type Tx } from '../changes';
import { agentInclude, teamInclude, toAgentRecord, toTeamRecord, uuids } from './agent-rows';

/** Listes du back-office : agents, activité, équipes. Curseur par décalage dans la liste triée. */

const offset = (page: PageRequest) => (page.cursor ? Number(page.cursor) : 0);

function slice<T>(items: T[], page: PageRequest): Page<T> {
  const start = offset(page);
  const next = start + page.limit;
  return {
    items: items.slice(start, next),
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
  };
}

const average = (agent: AgentRecord) => (agent.ratingCount ? agent.ratingSum / agent.ratingCount : -1);

/**
 * Agents filtrés puis triés en mémoire (quelques centaines au plus) : « lastName » trie sur le nom
 * affiché, la note moyenne se déduit de la somme et du nombre des notes.
 */
export async function listAgents(client: Tx, filter: AgentFilter, page: PageRequest, now: Date) {
  const where: Prisma.AgentWhereInput = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.zoneKey ? { zones: { some: { communeKey: filter.zoneKey } } } : {}),
    ...(filter.skillCode ? { skills: { some: { skillCode: filter.skillCode, status: 'validated' } } } : {}),
    ...(filter.q ? { displayName: { contains: filter.q, mode: 'insensitive' } } : {}),
  };
  const agents = (await client.agent.findMany({ where, include: agentInclude(now) })).map(toAgentRecord);
  const sorters: Record<AgentFilter['sort'], (a: AgentRecord, b: AgentRecord) => number> = {
    lastName: (a, b) => a.displayName.localeCompare(b.displayName, 'fr') || a.id.localeCompare(b.id),
    '-createdAt': (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    '-ratingAverage': (a, b) => average(b) - average(a) || a.id.localeCompare(b.id),
  };
  return slice(agents.sort(sorters[filter.sort]), page);
}

interface StatsRow {
  agent_id: string;
  sessions: number;
  visits: number;
  week_minutes: number;
  month_minutes: number;
  open_claims: number;
}

/**
 * Activité (R-AG-04), sans montants : séances et visites réalisées où l'agent était confirmé,
 * heures prévues de celles réalisées dans la semaine ISO et le mois en cours (heure de Porto-Novo),
 * réclamations ouvertes sur ses séances.
 */
export async function agentStats(client: Tx, agentIds: readonly string[], now: Date) {
  const ids = uuids(agentIds);
  const result = new Map<string, AgentStatsRecord>();
  if (!ids.length) return result;
  const today = localPosition(now).day;
  const week = localDayStart(isoWeekMonday(today));
  const month = localDayStart(`${today.slice(0, 8)}01`);
  const rows = await client.$queryRaw<StatsRow[]>`
    SELECT a.agent_id::text AS agent_id,
      count(*) FILTER (WHERE s.status = 'completed')::int AS sessions,
      count(*) FILTER (WHERE v.status = 'completed')::int AS visits,
      coalesce(sum(extract(epoch FROM coalesce(s.scheduled_end, v.scheduled_end) - coalesce(s.scheduled_start, v.scheduled_start)) / 60)
        FILTER (WHERE (s.status = 'completed' OR v.status = 'completed') AND coalesce(s.scheduled_start, v.scheduled_start) >= ${week}), 0)::float AS week_minutes,
      coalesce(sum(extract(epoch FROM coalesce(s.scheduled_end, v.scheduled_end) - coalesce(s.scheduled_start, v.scheduled_start)) / 60)
        FILTER (WHERE (s.status = 'completed' OR v.status = 'completed') AND coalesce(s.scheduled_start, v.scheduled_start) >= ${month}), 0)::float AS month_minutes,
      (SELECT count(*) FROM claims c JOIN assignments x ON x.session_id = c.session_id
        WHERE x.agent_id = a.agent_id AND x.status = 'confirmed' AND c.status IN ('open', 'in_progress'))::int AS open_claims
    FROM assignments a
    LEFT JOIN sessions s ON s.id = a.session_id
    LEFT JOIN visits v ON v.id = a.visit_id
    WHERE a.agent_id = ANY(${ids}::uuid[]) AND a.status = 'confirmed'
    GROUP BY a.agent_id`;
  for (const row of rows) {
    result.set(row.agent_id, {
      sessionsCompleted: row.sessions,
      visitsCompleted: row.visits,
      hoursThisWeek: Math.round((row.week_minutes / 60) * 100) / 100,
      hoursThisMonth: Math.round((row.month_minutes / 60) * 100) / 100,
      openClaims: row.open_claims,
    });
  }
  return result;
}

export async function listTeams(client: Tx, filter: { active: boolean | null }, page: PageRequest) {
  const where = filter.active === null ? {} : { active: filter.active };
  const [rows, total] = await Promise.all([
    client.team.findMany({
      where,
      include: teamInclude,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: offset(page),
      take: page.limit,
    }),
    client.team.count({ where }),
  ]);
  const next = offset(page) + page.limit;
  return {
    items: rows.map(toTeamRecord) as TeamRecord[],
    nextCursor: next < total ? String(next) : null,
    total,
  };
}
