import { requirePermission } from '@ksp/platform';
import { type ApprovalTarget, approveProposals } from '../../domain/auto-planning/approval';
import { type AgentCheck } from '../../domain/planning/assignment-check';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { cleaningErrors } from '../shared/errors';
import { replayed, writeError } from '../shared/idempotency';
import { idempotencyKey, isOffsetCursor, isUuid, page, type Page, requestHash } from '../shared/input';
import {
  type AgentCheckView,
  agentCheckView,
  assignmentView,
  type AssignmentView,
  planningAgents,
  planningContext,
  planningRefusal,
  placesOf,
  requireAgents,
  sameTarget,
  uniqueTargets,
} from '../planning/assignment-support';
import { type AssignmentBatchView, announceAssignments } from '../planning/assignment.use-cases';
import { type AssignmentRecord, type PlanningReader } from '../planning/planning.ports';
import { PLANNING_PERMISSION } from './auto-planning.use-cases';

/**
 * Propositions de la planification automatique (R-PL-05, UC-NT-38) : liste et validation en un
 * clic. La validation refait les contrôles de 9.4 sous le verrou de l'agenda des agents (RV-75) ;
 * une proposition devenue impossible est signalée (`skipped`) et ignorée, elle reste proposée.
 */

/** Propositions validées d'un coup, au plus (même borne que les listes). */
export const MAX_APPROVALS = 100;

/** File des propositions, les plus proches d'abord (tri « start »). */
export class ListProposalsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    zoneKey?: string | null;
    limit?: number;
    cursor?: string;
    sort?: string;
  }): Promise<Page<AssignmentView>> {
    requireStaff();
    const zoneKey = input.zoneKey || null;
    requirePermission(PLANNING_PERMISSION, zoneKey ?? undefined);
    if (input.sort && input.sort !== 'start') throw cleaningErrors.invalid('sort', 'invalid_type');
    const now = this.deps.clock.now();
    const result = await this.deps.autoPlanning.proposals(
      { zoneKey },
      page(input.limit, input.cursor, isOffsetCursor),
    );
    return {
      ...result,
      items: result.items.map((record) => assignmentView(record, record.agentName, null, now)),
    };
  }
}

function parseIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)];
  if (!unique.length) throw cleaningErrors.invalid('assignmentIds', 'required');
  if (unique.length > MAX_APPROVALS) throw cleaningErrors.invalid('assignmentIds', 'out_of_range');
  unique.forEach((id, index) => {
    if (!isUuid(id)) throw cleaningErrors.invalid(`assignmentIds[${index}]`, 'invalid_type');
  });
  return unique;
}

/** Affectations demandées, toutes trouvées ; sinon CLEANING_ASSIGNMENT_NOT_FOUND. */
async function requireAssignments(
  reader: PlanningReader,
  ids: readonly string[],
): Promise<AssignmentRecord[]> {
  const found = await Promise.all(ids.map((id) => reader.assignment(id)));
  if (found.some((a) => a === null)) throw cleaningErrors.assignmentNotFound();
  return found as AssignmentRecord[];
}

/** Contrôles en échec d'un agent, lus dans les motifs de refus (details.checks). */
function failedChecks(
  errors: readonly { details: Record<string, unknown> }[],
  agentId: string,
): AgentCheck[] {
  return errors.flatMap((error) =>
    Array.isArray(error.details.checks)
      ? (error.details.checks as AgentCheck[]).filter((check) => check.agentId === agentId)
      : [],
  );
}

/** Valider des propositions en un clic (ApproveProposals). */
export class ApproveProposalsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { idempotencyKey: string; assignmentIds: string[] }): Promise<AssignmentBatchView> {
    const actorId = requireStaff();
    requirePermission(PLANNING_PERMISSION);
    const key = idempotencyKey(input.idempotencyKey);
    const ids = parseIds(input.assignmentIds);
    const hash = requestHash({ assignmentIds: [...ids].sort() });
    const ref = { actorId, operation: 'planning.proposals_approve', key };
    const replay = await replayed<AssignmentBatchView>(this.deps.autoPlanning, ref, hash);
    if (replay) return replay;

    const repository = this.deps.autoPlanning;
    const before = await requireAssignments(repository, ids);
    const lockIds = [...new Set(before.map((a) => a.agentId))];
    const refs = uniqueTargets(before.map((a) => a.target));
    const beforeTargets = await repository.targets(refs);
    const beforeAgents = await requireAgents(repository, lockIds);
    const travel = await this.deps.travel.matrix(
      placesOf(beforeTargets, await planningAgents(repository, beforeAgents, beforeTargets)),
    );
    const names = new Map(beforeAgents.map((a) => [a.id, a.displayName]));
    const now = this.deps.clock.now();
    try {
      return await repository.transaction(async (tx) => {
        await tx.lockAgents(lockIds);
        const rows = await requireAssignments(tx, ids);
        const targets = await tx.targets(refs);
        const agents = await planningAgents(tx, await requireAgents(tx, lockIds), targets);
        const approvalTargets: ApprovalTarget[] = targets.map((target) => ({
          target,
          proposals: rows
            .filter((row) => sameTarget(row.target, target.target))
            .map((row) => ({
              assignmentId: row.id,
              agentId: row.agentId,
              isLead: row.isLead,
              status: row.status,
              respondBefore: row.respondBefore,
            })),
        }));
        const outcome = approveProposals({
          targets: approvalTargets,
          agents,
          context: await planningContext(tx, travel, now),
        });
        if (!outcome.approved.length) {
          throw planningRefusal(outcome.ignored.flatMap((ignored) => ignored.errors));
        }
        for (const approved of outcome.approved) {
          const done = await tx.approveProposal({
            id: approved.assignmentId,
            status: approved.status,
            respondBefore: approved.respondBefore,
            occupiedFrom: approved.occupied.start,
            occupiedUntil: approved.occupied.end,
            travelMinutes: approved.travelMinutes,
            approvedBy: actorId,
            approvedAt: now,
          });
          if (!done) throw cleaningErrors.concurrentUpdate();
        }
        const approvedRows = outcome.approved.map((approved) => {
          const row = rows.find((r) => r.id === approved.assignmentId)!;
          return { ...row, status: approved.status, respondBefore: approved.respondBefore };
        });
        const { events, batchId } = await announceAssignments(this.deps, tx, approvedRows, now);
        await tx.write({ events, audit: [] });
        const checks = outcome.approved.map((approved): AgentCheckView => ({
          agentId: approved.agentId,
          target: approvedRows.find((r) => r.id === approved.assignmentId)!.target,
          passed: true,
          results: [],
        }));
        const skipped = outcome.ignored.flatMap((ignored) =>
          ignored.assignmentIds.map((id): AgentCheckView => {
            const row = rows.find((r) => r.id === id)!;
            const [check] = failedChecks(ignored.errors, row.agentId);
            return check
              ? agentCheckView(check)
              : { agentId: row.agentId, target: row.target, passed: false, results: [] };
          }),
        );
        const response: AssignmentBatchView = {
          assignments: approvedRows.map((row) =>
            assignmentView(row, names.get(row.agentId) ?? '', null, now),
          ),
          checks,
          warnings: [],
          batchId,
          skipped,
        };
        await tx.remember({ ...ref, requestHash: hash, response });
        return response;
      });
    } catch (error) {
      throw writeError(error, lockIds);
    }
  }
}
