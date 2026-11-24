import { type TargetRef, type TravelTime } from '../../domain/planning/agenda';
import { type AssignmentRequest, planAssignments } from '../../domain/planning/assignment-batch';
import {
  type CheckOverride,
  OVERRIDABLE_CHECKS,
  type OverridableCheck,
  type TargetCheck,
} from '../../domain/planning/assignment-check';
import { effectiveAssignmentStatus, isInForce } from '../../domain/planning/assignment-status';
import { type PlanningErrorCode, planningError } from '../../domain/planning/errors';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type OutboxMessage } from '../ports';
import { requireStaff } from '../shared/access';
import { cleaningErrors, planningAppError } from '../shared/errors';
import { replayed, writeError } from '../shared/idempotency';
import { idempotencyKey, requestHash, requiredReason, text } from '../shared/input';
import {
  type AgentCheckView,
  agentCheckView,
  assignedEvent,
  assignmentView,
  type AssignmentView,
  audit,
  planningAgents,
  planningContext,
  planningRefusal,
  placesOf,
  releaseAssignments,
  requireAgents,
  requireTargets,
  sameTarget,
  unassignedEvent,
} from './assignment-support';
import {
  type AssignmentRecord,
  type NewAssignment,
  type PlanningReader,
  type PlanningTx,
  type TargetRecord,
} from './planning.ports';

/**
 * Planification manuelle (UC-NT-37, parties 9.4 à 9.6) : contrôler, affecter (unitaire ou en lot),
 * remplacer un agent ou changer le chef d'équipe, désaffecter. Les écritures se font sous le verrou
 * de l'agenda des agents concernés (RV-75), contrôles refaits sur l'agenda relu sous ce verrou ; la
 * contrainte assignments_no_overlap reste le dernier rempart (CLEANING_SCHEDULE_CONFLICT).
 */

export interface AssignmentInput {
  targets: { kind: string; id: string }[];
  agentIds: string[];
  teamId?: string | null;
  leadAgentId?: string | null;
  overrides: { check: string; reason: string }[];
}

interface ParsedRequest {
  targets: TargetRef[];
  agentIds: string[];
  teamId: string | null;
  leadAgentId: string | null;
  overrides: CheckOverride[];
}

/** Résultat d'une affectation (AssignmentBatch), rejouable à l'identique. */
export interface AssignmentBatchView {
  assignments: AssignmentView[];
  checks: AgentCheckView[];
  warnings: string[];
  batchId: string | null;
  skipped: AgentCheckView[];
}

/** Motifs propres aux contrôles d'un agent (rendus par CheckAssignment) ; les autres sont des erreurs. */
const CHECK_CODES: readonly PlanningErrorCode[] = [
  'CLEANING_AGENT_NOT_ACTIVE',
  'CLEANING_SKILL_MISSING',
  'CLEANING_AGENT_OUT_OF_ZONE',
  'CLEANING_AGENT_UNAVAILABLE',
  'CLEANING_AGENT_ON_LEAVE',
  'CLEANING_SCHEDULE_CONFLICT',
  'CLEANING_AGENT_OVERLOADED',
  'CLEANING_TEAM_SIZE_MISMATCH',
];

function parseOverrides(overrides: AssignmentInput['overrides']): CheckOverride[] {
  return overrides.map((override, index) => {
    if (!(OVERRIDABLE_CHECKS as readonly string[]).includes(override.check)) {
      throw cleaningErrors.invalid(`overrides[${index}].check`, 'invalid_type');
    }
    return {
      check: override.check as OverridableCheck,
      reason: text(override.reason, `overrides[${index}].reason`) ?? '',
    };
  });
}

function parseRequest(input: AssignmentInput): ParsedRequest {
  const targets = input.targets.map((target, index) => {
    if (target.kind !== 'visit' && target.kind !== 'session') {
      throw cleaningErrors.invalid(`targets[${index}].kind`, 'invalid_type');
    }
    if (!target.id) throw cleaningErrors.invalid(`targets[${index}].id`, 'required');
    return { kind: target.kind, id: target.id } as TargetRef;
  });
  if (targets.some((t, i) => targets.findIndex((o) => sameTarget(t, o)) !== i)) {
    throw cleaningErrors.invalid('targets', 'duplicate');
  }
  return {
    targets,
    agentIds: [...new Set(input.agentIds)],
    teamId: input.teamId || null,
    leadAgentId: input.leadAgentId || null,
    overrides: parseOverrides(input.overrides),
  };
}

/** Cibles, équipe et agents relus (sous verrou dans une transaction), prêts pour le domaine. */
async function loadRequest(
  reader: PlanningReader,
  request: ParsedRequest,
): Promise<{
  targets: TargetRecord[];
  domain: Omit<AssignmentRequest, 'skipFailing'>;
  names: Map<string, string>;
}> {
  const targets = await requireTargets(reader, request.targets);
  const team = request.teamId ? await reader.teamById(request.teamId) : null;
  if (request.teamId && !team) throw cleaningErrors.teamNotFound();
  const agents = await requireAgents(reader, team ? team.members.map((m) => m.agentId) : request.agentIds);
  return {
    targets,
    names: new Map(agents.map((a) => [a.id, a.displayName])),
    domain: {
      targets,
      agents: await planningAgents(reader, agents, targets),
      team: team ? { teamId: team.id, active: team.active, leadAgentId: team.leadAgentId } : null,
      leadAgentId: request.leadAgentId,
      overrides: request.overrides,
    },
  };
}

/** Agents dont l'agenda est verrouillé : désignés, ou membres de l'équipe. */
async function agentsToLock(reader: PlanningReader, request: ParsedRequest): Promise<string[]> {
  if (!request.teamId) return request.agentIds;
  const team = await reader.teamById(request.teamId);
  if (!team) throw cleaningErrors.teamNotFound();
  return team.members.map((m) => m.agentId);
}

/** Matrice des trajets entre les lieux des cibles et des agendas, calculée hors transaction. */
async function travelFor(deps: CleaningDeps, request: ParsedRequest): Promise<TravelTime> {
  const loaded = await loadRequest(deps.planning, request);
  return deps.travel.matrix(placesOf(loaded.targets, loaded.domain.agents));
}

const checksOf = (checks: readonly TargetCheck[]) =>
  checks.flatMap((check) => [...check.agentChecks, ...check.signaled]).map(agentCheckView);

/** Contrôles en direct du glisser-déposer (9.6) : rien n'est enregistré, aucun verrou. */
export class CheckAssignmentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: AssignmentInput): Promise<{ passed: boolean; checks: AgentCheckView[] }> {
    requireStaff();
    const request = parseRequest(input);
    const now = this.deps.clock.now();
    const travel = await travelFor(this.deps, request);
    const loaded = await loadRequest(this.deps.planning, request);
    const outcome = planAssignments(
      { ...loaded.domain, skipFailing: false },
      await planningContext(this.deps.planning, travel, now),
    );
    const blocking = outcome.errors.filter((error) => !CHECK_CODES.includes(error.code));
    if (blocking.length) throw planningRefusal(blocking);
    return { passed: outcome.ok, checks: checksOf(outcome.checks) };
  }
}

/** Raison enregistrée d'une affectation qui contourne des contrôles (motifs saisis, sans doublon). */
function overrideReason(
  overrides: readonly CheckOverride[],
  used: readonly OverridableCheck[],
): string | null {
  const reasons = [...new Set(overrides.filter((o) => used.includes(o.check)).map((o) => o.reason))];
  return reasons.length ? reasons.join(' ; ') : null;
}

function newRows(
  deps: CleaningDeps,
  retained: readonly TargetCheck[],
  overrides: readonly CheckOverride[],
  actorId: string,
  now: Date,
): NewAssignment[] {
  return retained.flatMap((check) =>
    check.agentChecks.map((agentCheck) => ({
      id: deps.ids.next(),
      target: check.target,
      agentId: agentCheck.agentId,
      isLead: agentCheck.agentId === check.leadAgentId,
      source: 'manual' as const,
      status: agentCheck.status,
      respondBefore: agentCheck.respondBefore,
      occupiedFrom: agentCheck.occupied.start,
      occupiedUntil: agentCheck.occupied.end,
      travelMinutes: agentCheck.travelMinutes,
      overrides: agentCheck.overridesUsed,
      reason: overrideReason(overrides, agentCheck.overridesUsed),
      createdBy: actorId,
      createdAt: now,
    })),
  );
}

function rowRecord(row: NewAssignment, target: TargetRecord): AssignmentRecord {
  return { ...row, start: target.start, end: target.end, placeId: target.placeId };
}

function creationAudit(rows: readonly NewAssignment[], actorId: string, now: Date): AuditEntry[] {
  return rows.flatMap((row) => [
    audit(actorId, 'assignment.created', 'assignment', row.id, now, {
      target: row.target,
      agentId: row.agentId,
      status: row.status,
      isLead: row.isLead,
    }),
    ...(row.overrides.length
      ? [audit(actorId, 'assignment.overridden', 'assignment', row.id, now, { checks: row.overrides })]
      : []),
  ]);
}

/**
 * Écritures d'une affectation acceptée : lignes, séances planifiées, événements (un récapitulatif
 * par programme dès deux séances, R-PL-11), traces.
 */
async function writeAssignments(
  deps: CleaningDeps,
  tx: PlanningTx,
  rows: readonly NewAssignment[],
  now: Date,
): Promise<{ events: OutboxMessage[]; batchId: string | null }> {
  await tx.insertAssignments(rows);
  return announceAssignments(deps, tx, rows, now);
}

/**
 * Suite d'affectations enregistrées (créées, ou propositions validées) : séances planifiées,
 * événements (un récapitulatif par programme dès deux séances, R-PL-11), avec la source des lignes.
 */
export async function announceAssignments(
  deps: Pick<CleaningDeps, 'ids'>,
  tx: PlanningTx,
  rows: readonly Pick<NewAssignment, 'target' | 'agentId' | 'source'>[],
  now: Date,
): Promise<{ events: OutboxMessage[]; batchId: string | null }> {
  const source = rows[0]?.source ?? 'manual';
  const refs = rows.map((r) => r.target).filter((t, i, all) => all.findIndex((o) => sameTarget(o, t)) === i);
  for (const ref of refs) if (ref.kind === 'session') await tx.setSessionStatus(ref.id, 'assigned', now);
  const targets = (await tx.targets(refs)).sort((a, b) => a.start.getTime() - b.start.getTime());
  const batches = new Map<string, TargetRecord[]>();
  for (const target of targets) {
    if (target.target.kind !== 'session') continue;
    batches.set(target.programId!, [...(batches.get(target.programId!) ?? []), target]);
  }
  const batchIds = new Map<string, string>();
  for (const [programId, sessions] of batches)
    if (sessions.length > 1) batchIds.set(programId, deps.ids.next());
  const events = targets.map((t) =>
    assignedEvent(t, now, (t.programId && batchIds.get(t.programId)) ?? null, source),
  );
  for (const [programId, batchId] of batchIds) {
    const sessions = batches.get(programId)!;
    const agentIds = [
      ...new Set(
        rows.filter((r) => sessions.some((s) => sameTarget(s.target, r.target))).map((r) => r.agentId),
      ),
    ];
    events.push({
      type: 'cleaning.sessions.batch_assigned',
      payload: {
        programId,
        customerId: sessions[0]!.customerId,
        organizationId: sessions[0]!.organizationId,
        batchId,
        sessionIds: sessions.map((s) => s.target.id),
        count: sessions.length,
        firstStart: sessions[0]!.start.toISOString(),
        lastStart: sessions.at(-1)!.start.toISOString(),
        agentIds,
        leadAgentId: sessions[0]!.assignments.find((a) => a.isLead)?.agentId ?? null,
        source,
        assignedAt: now.toISOString(),
      },
    });
  }
  return { events, batchId: [...batchIds.values()][0] ?? null };
}

/** Affecter des agents ou une équipe à une ou plusieurs cibles (tout ou rien, sauf skipFailing). */
export class CreateAssignmentsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(
    input: AssignmentInput & { idempotencyKey: string; skipFailing?: boolean },
  ): Promise<AssignmentBatchView> {
    const actorId = requireStaff();
    const key = idempotencyKey(input.idempotencyKey);
    const request = parseRequest(input);
    const skipFailing = input.skipFailing ?? false;
    const hash = requestHash({ ...request, skipFailing });
    const ref = { actorId, operation: 'assignment.create', key };
    const replay = await replayed<AssignmentBatchView>(this.deps.planning, ref, hash);
    if (replay) return replay;

    const now = this.deps.clock.now();
    const lockIds = await agentsToLock(this.deps.planning, request);
    const travel = await travelFor(this.deps, request);
    const actorName = (await this.deps.people.userNames([actorId])).get(actorId) ?? null;
    try {
      return await this.deps.planning.transaction(async (tx) => {
        await tx.lockAgents(lockIds);
        const loaded = await loadRequest(tx, request);
        const outcome = planAssignments(
          { ...loaded.domain, skipFailing },
          await planningContext(tx, travel, now),
        );
        if (!outcome.ok) throw planningRefusal(outcome.errors);
        const rows = newRows(this.deps, outcome.retained, request.overrides, actorId, now);
        const { events, batchId } = await writeAssignments(this.deps, tx, rows, now);
        await tx.write({ events, audit: creationAudit(rows, actorId, now) });
        const response: AssignmentBatchView = {
          assignments: rows.map((row) =>
            assignmentView(
              rowRecord(
                row,
                loaded.targets.find((t) => sameTarget(t.target, row.target))!,
              ),
              loaded.names.get(row.agentId) ?? '',
              actorName,
              now,
            ),
          ),
          checks: checksOf(outcome.retained),
          warnings: [...new Set(outcome.retained.flatMap((check) => check.warnings))],
          batchId,
          skipped: checksOf(outcome.skipped),
        };
        await tx.remember({ ...ref, requestHash: hash, response });
        return response;
      });
    } catch (error) {
      throw writeError(error, lockIds);
    }
  }
}

/** Affectation en vigueur, relue sous verrou ; sinon CLEANING_INVALID_TRANSITION. */
async function inForceAssignment(
  tx: PlanningReader,
  id: string,
  to: string,
  now: Date,
): Promise<AssignmentRecord> {
  const assignment = await tx.assignment(id);
  if (!assignment) throw cleaningErrors.assignmentNotFound();
  if (!isInForce(assignment, now)) {
    throw planningAppError(
      planningError('CLEANING_INVALID_TRANSITION', { from: effectiveAssignmentStatus(assignment, now), to }),
    );
  }
  return assignment;
}

/** Désaffecter un agent (motif obligatoire) : la séance repasse « à affecter » si son équipe devient incomplète. */
export class RemoveAssignmentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { assignmentId: string; idempotencyKey: string; reason: string }): Promise<void> {
    const actorId = requireStaff();
    const key = idempotencyKey(input.idempotencyKey);
    const reason = requiredReason(input.reason);
    const hash = requestHash({ assignmentId: input.assignmentId, reason });
    const ref = { actorId, operation: 'assignment.remove', key };
    if (await replayed(this.deps.planning, ref, hash)) return;
    const existing = await this.deps.planning.assignment(input.assignmentId);
    if (!existing) throw cleaningErrors.assignmentNotFound();
    const now = this.deps.clock.now();
    try {
      await this.deps.planning.transaction(async (tx) => {
        await tx.lockAgents([existing.agentId]);
        const assignment = await inForceAssignment(tx, existing.id, 'removed', now);
        const changes = await releaseAssignments(tx, [assignment], {
          actorId,
          by: actorId,
          reason,
          cause: 'manual',
          at: now,
        });
        await tx.write(changes);
        await tx.remember({ ...ref, requestHash: hash, response: { removed: assignment.id } });
      });
    } catch (error) {
      throw writeError(error);
    }
  }
}

/**
 * Remplacer un agent (mêmes contrôles qu'à l'affectation pour le remplaçant) ou changer le chef
 * d'équipe (R-EQ-03). Motif obligatoire, tracé.
 */
export class UpdateAssignmentUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    assignmentId: string;
    replaceWithAgentId?: string | null;
    isLead?: boolean | null;
    overrides?: AssignmentInput['overrides'] | null;
    reason: string;
  }): Promise<AssignmentBatchView> {
    const actorId = requireStaff();
    const reason = requiredReason(input.reason);
    const existing = await this.deps.planning.assignment(input.assignmentId);
    if (!existing) throw cleaningErrors.assignmentNotFound();
    const now = this.deps.clock.now();
    if (input.replaceWithAgentId) {
      return this.replace(
        existing,
        input.replaceWithAgentId,
        parseOverrides(input.overrides ?? []),
        reason,
        actorId,
        now,
      );
    }
    if (input.isLead === true) return this.makeLead(existing, actorId, now);
    throw cleaningErrors.invalid('replaceWithAgentId', 'required');
  }

  private async replace(
    existing: AssignmentRecord,
    agentId: string,
    overrides: CheckOverride[],
    reason: string,
    actorId: string,
    now: Date,
  ): Promise<AssignmentBatchView> {
    const request: ParsedRequest = {
      targets: [existing.target],
      agentIds: [agentId],
      teamId: null,
      leadAgentId: null,
      overrides,
    };
    const travel = await travelFor(this.deps, request);
    const actorName = (await this.deps.people.userNames([actorId])).get(actorId) ?? null;
    try {
      return await this.deps.planning.transaction(async (tx) => {
        await tx.lockAgents([existing.agentId, agentId]);
        const current = await inForceAssignment(tx, existing.id, 'removed', now);
        const loaded = await loadRequest(tx, { ...request, leadAgentId: current.isLead ? agentId : null });
        // Le remplaçant se contrôle sur l'équipe sans l'agent remplacé.
        const target = loaded.targets[0]!;
        const without = {
          ...target,
          assignments: target.assignments.filter((a) => a.id !== current.id),
          assignedAgents: target.assignedAgents.filter((a) => a.agentId !== current.agentId),
        };
        const outcome = planAssignments(
          { ...loaded.domain, targets: [without], skipFailing: false },
          await planningContext(tx, travel, now),
        );
        if (!outcome.ok) throw planningRefusal(outcome.errors);
        await tx.removeAssignments([current.id], { by: actorId, reason, at: now });
        const rows = newRows(this.deps, outcome.retained, overrides, actorId, now);
        const { events } = await writeAssignments(this.deps, tx, rows, now);
        const [after] = await tx.targets([current.target]);
        await tx.write({
          events: [unassignedEvent(after!, [current.agentId], 'manual', now), ...events],
          audit: [
            ...creationAudit(rows, actorId, now),
            audit(actorId, 'assignment.replaced', 'assignment', current.id, now, {
              target: current.target,
              before: current.agentId,
              after: agentId,
            }),
          ],
        });
        return {
          assignments: rows.map((row) =>
            assignmentView(rowRecord(row, target), loaded.names.get(row.agentId) ?? '', actorName, now),
          ),
          checks: checksOf(outcome.retained),
          warnings: [...new Set(outcome.retained.flatMap((check) => check.warnings))],
          batchId: null,
          skipped: [],
        };
      });
    } catch (error) {
      throw writeError(error, [agentId]);
    }
  }

  private async makeLead(
    existing: AssignmentRecord,
    actorId: string,
    now: Date,
  ): Promise<AssignmentBatchView> {
    return this.deps.planning.transaction(async (tx) => {
      await tx.lockAgents([existing.agentId]);
      const current = await inForceAssignment(tx, existing.id, existing.status, now);
      const [target] = await tx.targets([current.target]);
      const previous = target!.assignments.find((a) => a.isLead);
      if (previous?.id !== current.id) {
        if (previous) await tx.setLead(previous.id, false);
        await tx.setLead(current.id, true);
        const [after] = await tx.targets([current.target]);
        await tx.write({
          events: [assignedEvent(after!, now, null)],
          audit: [
            audit(actorId, 'assignment.lead_changed', 'assignment', current.id, now, {
              target: current.target,
              before: previous?.agentId ?? null,
              after: current.agentId,
            }),
          ],
        });
      }
      const [after] = await tx.targets([current.target]);
      const agents = await tx.agentsByIds(after!.assignments.map((a) => a.agentId));
      const names = await this.deps.people.userNames(
        after!.assignments.flatMap((a) => (a.createdBy ? [a.createdBy] : [])),
      );
      return {
        assignments: after!.assignments.map((a) =>
          assignmentView(
            a,
            agents.find((g) => g.id === a.agentId)?.displayName ?? '',
            a.createdBy ? (names.get(a.createdBy) ?? null) : null,
            now,
          ),
        ),
        checks: [],
        warnings: [],
        batchId: null,
        skipped: [],
      };
    });
  }
}
