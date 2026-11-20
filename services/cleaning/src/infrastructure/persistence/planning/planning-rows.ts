import { type Prisma } from '../../../../prisma/generated';
import { validatedSkillCodes } from '../../../domain/agents/agent';
import { type AgendaEntry } from '../../../domain/planning/agenda';
import { IN_FORCE_STATUSES, isInForce } from '../../../domain/planning/assignment-status';
import { type AssignmentRecord, type TargetRecord } from '../../../application/planning/planning.ports';
import { type Tx } from '../changes';

/**
 * Cibles (séances, visites) et affectations telles que la planification les lit. Le client du
 * dossier est le titulaire (compte), ou l'auteur de la demande pour une organisation.
 */

type Client = Tx;

export const IN_FORCE = [...IN_FORCE_STATUSES] as ('proposed' | 'pending_confirmation' | 'confirmed')[];

const assignmentTarget = {
  session: { select: { scheduledStart: true, scheduledEnd: true, program: { select: { placeId: true } } } },
  visit: { select: { scheduledStart: true, scheduledEnd: true, request: { select: { placeId: true } } } },
} satisfies Prisma.AssignmentInclude;

type AssignmentRow = Prisma.AssignmentGetPayload<{ include: typeof assignmentTarget }>;

export function toAssignmentRecord(row: AssignmentRow): AssignmentRecord {
  const target = row.session ?? row.visit!;
  return {
    id: row.id,
    target:
      row.targetKind === 'session'
        ? { kind: 'session', id: row.sessionId! }
        : { kind: 'visit', id: row.visitId! },
    agentId: row.agentId,
    isLead: row.isLead,
    source: row.source,
    status: row.status,
    respondBefore: row.responseDueAt,
    overrides: row.overrides,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    start: target.scheduledStart,
    end: target.scheduledEnd,
    occupiedFrom: row.occupiedFrom,
    travelMinutes: row.travelMinutes,
    placeId: row.session ? row.session.program.placeId : row.visit!.request.placeId,
  };
}

export async function findAssignment(client: Client, id: string): Promise<AssignmentRecord | null> {
  const row = await client.assignment.findUnique({ where: { id }, include: assignmentTarget });
  return row ? toAssignmentRecord(row) : null;
}

export async function findAssignments(
  client: Client,
  where: Prisma.AssignmentWhereInput,
  extra: Partial<Prisma.AssignmentFindManyArgs> = {},
) {
  const rows = await client.assignment.findMany({ where, include: assignmentTarget, ...extra } as never);
  return (rows as unknown as AssignmentRow[]).map(toAssignmentRecord);
}

/** Affectations en vigueur des agents dont la période occupée touche la fenêtre. */
export async function agendas(
  client: Client,
  agentIds: readonly string[],
  window: { start: Date; end: Date | null },
): Promise<Map<string, AgendaEntry[]>> {
  const result = new Map<string, AgendaEntry[]>(agentIds.map((id) => [id, []]));
  const rows = await client.assignment.findMany({
    where: {
      agentId: { in: [...agentIds] },
      status: { in: IN_FORCE },
      occupiedUntil: { gt: window.start },
      ...(window.end ? { occupiedFrom: { lt: window.end } } : {}),
    },
    include: assignmentTarget,
    orderBy: { occupiedFrom: 'asc' },
  });
  for (const row of rows) {
    const record = toAssignmentRecord(row);
    result.get(row.agentId)?.push({
      assignmentId: row.id,
      target: record.target,
      placeId: record.placeId,
      start: record.start,
      end: row.occupiedUntil,
      travelMinutes: row.travelMinutes,
      status: row.status,
      respondBefore: row.responseDueAt,
    });
  }
  return result;
}

const requestSelect = {
  id: true,
  number: true,
  ownerKind: true,
  ownerId: true,
  submittedBy: true,
  placeId: true,
  communeKey: true,
  zone: { select: { name: true } },
  place: { select: { placeType: { select: { name: true } } } },
  items: {
    select: {
      offer: {
        select: {
          cleaningType: {
            select: {
              id: true,
              code: true,
              name: true,
              requiredSkillCode: true,
              packItems: { select: { item: { select: { requiredSkillCode: true } } } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CleaningRequestSelect;

type RequestRow = Prisma.CleaningRequestGetPayload<{ select: typeof requestSelect }>;

function customer(request: Pick<RequestRow, 'ownerKind' | 'ownerId' | 'submittedBy'>) {
  return request.ownerKind === 'user'
    ? { customerId: request.ownerId, organizationId: null }
    : { customerId: request.submittedBy, organizationId: request.ownerId };
}

/** Compétences exigées par les types de la demande, paquets compris (R-CA-09). */
function requiredSkills(request: RequestRow): string[] {
  const codes = request.items.flatMap(({ offer: { cleaningType } }) => [
    cleaningType.requiredSkillCode,
    ...cleaningType.packItems.map((p) => p.item.requiredSkillCode),
  ]);
  return [...new Set(codes.filter((code): code is string => code !== null))].sort();
}

const sessionInclude = {
  program: {
    select: {
      id: true,
      number: true,
      placeId: true,
      teamSize: true,
      request: { select: requestSelect },
      _count: { select: { sessions: true } },
    },
  },
  zone: { select: { name: true } },
} satisfies Prisma.SessionInclude;

const visitInclude = { request: { select: requestSelect } } satisfies Prisma.VisitInclude;

/** Affectations en vigueur des cibles, avec les compétences validées de leurs agents. */
async function inForceByTarget(client: Client, sessionIds: string[], visitIds: string[], now: Date) {
  const rows = await client.assignment.findMany({
    where: {
      status: { in: IN_FORCE },
      OR: [{ sessionId: { in: sessionIds } }, { visitId: { in: visitIds } }],
    },
    include: {
      ...assignmentTarget,
      agent: { select: { skills: { select: { skillCode: true, status: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows
    .filter((row) => isInForce({ status: row.status, respondBefore: row.responseDueAt }, now))
    .map((row) => ({
      record: toAssignmentRecord(row),
      skills: [
        ...validatedSkillCodes(row.agent.skills.map((s) => ({ code: s.skillCode, status: s.status }))),
      ],
    }));
}

/** Cibles trouvées parmi les séances et visites demandées. */
export async function loadTargets(
  client: Client,
  sessionIds: readonly string[],
  visitIds: readonly string[],
  now: Date,
): Promise<TargetRecord[]> {
  const [sessions, visits, assigned] = await Promise.all([
    sessionIds.length
      ? client.session.findMany({ where: { id: { in: [...sessionIds] } }, include: sessionInclude })
      : [],
    visitIds.length
      ? client.visit.findMany({ where: { id: { in: [...visitIds] } }, include: visitInclude })
      : [],
    inForceByTarget(client, [...sessionIds], [...visitIds], now),
  ]);
  const of = (kind: 'session' | 'visit', id: string) => {
    const list = assigned.filter((a) => a.record.target.kind === kind && a.record.target.id === id);
    return {
      assignments: list.map((a) => a.record),
      assignedAgents: list.map((a) => ({
        agentId: a.record.agentId,
        isLead: a.record.isLead,
        validatedSkills: a.skills,
      })),
    };
  };
  const cleaningTypes = (request: RequestRow) =>
    request.items.map(({ offer: { cleaningType: t } }) => ({ id: t.id, code: t.code, name: t.name }));
  return [
    ...sessions.map((s): TargetRecord => ({
      target: { kind: 'session', id: s.id },
      status: s.status,
      placeId: s.program.placeId,
      communeKey: s.communeKey,
      communeName: s.zone.name,
      start: s.scheduledStart,
      end: s.scheduledEnd,
      requiredSkills: requiredSkills(s.program.request),
      expectedTeamSize: s.program.teamSize,
      number: s.program.number,
      rank: s.rank,
      programId: s.program.id,
      requestId: s.program.request.id,
      ...customer(s.program.request),
      sessionsCount: s.program._count.sessions,
      placeTypeName: s.program.request.place.placeType.name,
      cleaningTypes: cleaningTypes(s.program.request),
      ...of('session', s.id),
    })),
    ...visits.map((v): TargetRecord => ({
      target: { kind: 'visit', id: v.id },
      status: v.status,
      placeId: v.request.placeId,
      communeKey: v.request.communeKey,
      communeName: v.request.zone.name,
      start: v.scheduledStart,
      end: v.scheduledEnd,
      requiredSkills: [],
      expectedTeamSize: null,
      number: v.request.number,
      rank: null,
      programId: null,
      requestId: v.request.id,
      ...customer(v.request),
      sessionsCount: null,
      placeTypeName: v.request.place.placeType.name,
      cleaningTypes: cleaningTypes(v.request),
      ...of('visit', v.id),
    })),
  ];
}
