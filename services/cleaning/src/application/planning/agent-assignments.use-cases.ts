import {
  type AssignmentStatus,
  effectiveAssignmentStatus,
  respondToAssignment,
} from '../../domain/planning/assignment-status';
import { addDays, localDayStart, localPosition } from '../../domain/planning/time';
import { type CleaningDeps } from '../deps';
import { requireConnectedUser } from '../shared/access';
import { cleaningErrors, refusal } from '../shared/errors';
import { replayed, writeError } from '../shared/idempotency';
import {
  idempotencyKey,
  optionalInstant,
  isOffsetCursor,
  page,
  type Page,
  requestHash,
} from '../shared/input';
import { afterDeparture } from './assignment-support';
import { type AgentAssignmentRecord } from './planning.ports';

/**
 * Application agent (UC-NT-21) : mon planning, et la réponse de l'indépendant à une affectation
 * (R-PL-08). Le statut rendu est le statut effectif : une attente échue est « expirée » (15.2).
 */

const STATUSES: readonly AssignmentStatus[] = [
  'proposed',
  'pending_confirmation',
  'confirmed',
  'declined',
  'expired',
  'removed',
];

export class AgentAssignmentUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  /** Période par défaut : du début du jour (Porto-Novo) à sept jours plus tard. */
  async list(input: {
    from?: string | null;
    to?: string | null;
    status?: string | null;
    limit?: number;
    cursor?: string;
  }): Promise<Page<AgentAssignmentRecord>> {
    const userId = requireConnectedUser();
    if (input.status && !STATUSES.includes(input.status as AssignmentStatus)) {
      throw cleaningErrors.invalid('status', 'invalid_type');
    }
    const now = this.deps.clock.now();
    const from = optionalInstant(input.from, 'from') ?? localDayStart(localPosition(now).day);
    const to = optionalInstant(input.to, 'to') ?? localDayStart(addDays(localPosition(from).day, 7));
    if (to <= from) throw cleaningErrors.invalid('to', 'out_of_range');
    const agent = await this.deps.planning.agentByUserId(userId);
    if (!agent) return { items: [], nextCursor: null, total: 0 };
    const result = await this.deps.planning.agentAssignments(
      agent.id,
      { window: { start: from, end: to }, status: (input.status as AssignmentStatus) || null },
      page(input.limit, input.cursor, isOffsetCursor),
    );
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, status: effectiveAssignmentStatus(item, now) })),
    };
  }

  /** Accepter ou refuser, tant que l'affectation attend la réponse ; un refus libère la place. */
  async respond(input: {
    assignmentId: string;
    idempotencyKey: string;
    answer: 'accept' | 'decline';
  }): Promise<AgentAssignmentRecord> {
    const userId = requireConnectedUser();
    const key = idempotencyKey(input.idempotencyKey);
    const agent = await this.deps.planning.agentByUserId(userId);
    if (!agent) throw cleaningErrors.assignmentNotFound();
    const hash = requestHash({ assignmentId: input.assignmentId, answer: input.answer });
    const ref = { actorId: userId, operation: `assignment.${input.answer}`, key };
    if (!(await replayed(this.deps.planning, ref, hash))) {
      const existing = await this.deps.planning.assignment(input.assignmentId);
      if (!existing || existing.agentId !== agent.id) throw cleaningErrors.assignmentNotFound();
      const now = this.deps.clock.now();
      try {
        await this.deps.planning.transaction(async (tx) => {
          await tx.lockAgents([agent.id]);
          const current = (await tx.assignment(existing.id))!;
          const decision = respondToAssignment(current, input.answer, now);
          if (!decision.ok) throw refusal(decision.errors);
          const to = decision.value as 'confirmed' | 'declined';
          await tx.respondAssignment(current.id, to, now);
          const events = to === 'declined' ? await afterDeparture(tx, [current], 'agent_declined', now) : [];
          // Réponse de l'agent : hors de la liste fermée du journal d'audit (R-AU-01).
          await tx.write({ events, audit: [] });
          await tx.remember({ ...ref, requestHash: hash, response: { assignmentId: current.id } });
        });
      } catch (error) {
        throw writeError(error);
      }
    }
    return this.view(input.assignmentId);
  }

  private async view(assignmentId: string): Promise<AgentAssignmentRecord> {
    const assignment = await this.deps.planning.assignment(assignmentId);
    if (!assignment) throw cleaningErrors.assignmentNotFound();
    const [target] = await this.deps.planning.targets([assignment.target]);
    return {
      ...assignment,
      status: effectiveAssignmentStatus(assignment, this.deps.clock.now()),
      targetStatus: target?.status ?? '',
      placeTypeName: target?.placeTypeName ?? '',
      communeName: target?.communeName ?? '',
    };
  }
}
