import { type Prisma } from '../../../../prisma/generated';
import { type AgentRecord, type TeamRecord } from '../../../application/agents/agent.ports';

/**
 * Lecture des agents et des équipes (tables agents, agent_skills, agent_zones,
 * availability_rules, unavailabilities, teams, team_members). Les exceptions passées ne sont pas
 * lues : seules comptent celles qui finissent après maintenant.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifiants lisibles par PostgreSQL ; un identifiant mal formé est simplement introuvable. */
export function uuids(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => UUID.test(id)))];
}

export const isUuid = (id: string) => UUID.test(id);

export function agentInclude(now: Date) {
  return {
    skills: { include: { skill: { select: { name: true } } }, orderBy: { skillCode: 'asc' } },
    zones: { orderBy: { communeKey: 'asc' } },
    availabilityRules: { orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] },
    unavailabilities: { where: { endsAt: { gt: now } }, orderBy: { startsAt: 'asc' } },
  } satisfies Prisma.AgentInclude;
}

export type AgentRow = Prisma.AgentGetPayload<{ include: ReturnType<typeof agentInclude> }>;

export function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    employmentKind: row.employmentKind,
    displayName: row.displayName,
    photoFileId: row.photoFileId,
    homeCommuneKey: row.homeCommuneKey,
    idDocumentEncrypted: row.idDocumentEncrypted,
    emergencyContactEncrypted: row.emergencyContactEncrypted,
    mobileMoneyEncrypted: row.mobileMoneyEncrypted,
    maxHoursDay: row.maxHoursDay,
    maxHoursWeek: row.maxHoursWeek,
    canLead: row.canLead,
    ratingSum: row.ratingSum,
    ratingCount: row.ratingCount,
    statusReason: row.statusReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    skills: row.skills.map((s) => ({ code: s.skillCode, name: s.skill.name, status: s.status })),
    zoneKeys: row.zones.map((z) => z.communeKey),
    weekly: row.availabilityRules.map((r) => ({
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
    extras: row.unavailabilities
      .filter((u) => u.kind === 'extra_availability')
      .map((u) => ({ id: u.id, start: u.startsAt, end: u.endsAt })),
    unavailabilities: row.unavailabilities
      .filter((u) => u.kind === 'unavailable')
      .map((u) => ({
        id: u.id,
        start: u.startsAt,
        end: u.endsAt,
        reason: u.reason ?? 'other',
        note: u.note,
        forced: u.forced,
        createdBy: u.createdBy,
        createdAt: u.createdAt,
      })),
  };
}

export const teamInclude = {
  members: {
    include: { agent: { select: { displayName: true, status: true } } },
    orderBy: { agentId: 'asc' },
  },
} satisfies Prisma.TeamInclude;

export type TeamRow = Prisma.TeamGetPayload<{ include: typeof teamInclude }>;

export function toTeamRecord(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    leadAgentId: row.leadAgentId,
    active: row.active,
    createdAt: row.createdAt,
    members: row.members.map((m) => ({
      agentId: m.agentId,
      displayName: m.agent.displayName,
      status: m.agent.status,
    })),
  };
}
