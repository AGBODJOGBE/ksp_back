import { selectByTransition } from '../../domain/request-group';
import { type QuoteRequest } from '../../domain/quote-request';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type GroupOperation, type GroupOutcome, type OutboxMessage } from '../ports';
import { closingChanges } from '../requests/customer-requests.use-cases';
import { currentCustomer, requireStaff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { optionalText, requiredText } from '../shared/validation';
import {
  anyGroup,
  emptyOutcome,
  operationRecord,
  ownGroup,
  parseKey,
  previousOutcome,
  settle,
} from './group-support';

/**
 * Refus du groupe par la supervision et annulation du groupe par le client (ADR-035) : la règle de
 * la demande seule s'applique à chacune (mêmes événements, même trace) ; les demandes acceptées ou
 * closes ne sont pas touchées et sont renvoyées comme ignorées.
 */
async function closeGroup(
  deps: CleaningDeps,
  input: {
    actorId: string;
    groupId: string;
    requests: QuoteRequest[];
    to: 'rejected' | 'cancelled';
    reason: string | null;
    key: string;
    operation: GroupOperation;
  },
): Promise<GroupOutcome> {
  const now = deps.clock.now();
  const { selected, skipped } = selectByTransition(input.requests, input.to, now);
  if (!selected.length) throw CleaningErrors.groupNothingEligible(skipped);
  const events: OutboxMessage[] = [];
  const audit: AuditEntry[] = [];
  const closed: QuoteRequest[] = [];
  for (const request of selected) {
    closed.push({ ...request, status: input.to, closingReason: input.reason, updatedAt: now });
    const changes = await closingChanges(deps, input.actorId, request, input.to, now, {
      groupId: input.groupId,
    });
    events.push(...changes.events);
    audit.push(...changes.audit);
  }
  const outcome: GroupOutcome = {
    ...emptyOutcome(input.groupId),
    affectedIds: selected.map((request) => request.id),
    skippedRequests: skipped,
  };
  audit.push({
    actorId: input.actorId,
    action: `request_group.${input.to}`,
    entityType: 'request_group',
    entityId: input.groupId,
    at: now,
    details: { requestIds: outcome.affectedIds, skipped: skipped.map((entry) => entry.requestId) },
  });
  const written = await deps.requests.saveGroup({
    requests: closed,
    changes: { events, audit },
    operation: operationRecord(input.actorId, input.operation, input.key, outcome),
  });
  return settle(
    deps,
    written,
    { actorId: input.actorId, operation: input.operation, key: input.key, groupId: input.groupId },
    outcome,
  );
}

/** Refus du groupe entier par le superviseur, motif obligatoire (ADR-035). */
export class RejectRequestGroupUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { groupId: string; reason: string; idempotencyKey?: string }): Promise<GroupOutcome> {
    const staff = requireStaff(SUPERVISION);
    const key = parseKey(input.idempotencyKey, false);
    const view = await anyGroup(this.deps, input.groupId);
    const replay = await previousOutcome(this.deps, staff.userId, 'group.rejected', key, view.group.id);
    if (replay) return replay;
    return closeGroup(this.deps, {
      actorId: staff.userId,
      groupId: view.group.id,
      requests: view.requests,
      to: 'rejected',
      reason: requiredText('reason', input.reason, 500),
      key,
      operation: 'group.rejected',
    });
  }
}

/** Annulation du groupe par son client (ADR-035), Idempotency-Key obligatoire. */
export class CancelRequestGroupUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { groupId: string; reason?: string; idempotencyKey: string }): Promise<GroupOutcome> {
    const customer = currentCustomer();
    const key = parseKey(input.idempotencyKey, true);
    const view = await ownGroup(this.deps, customer, input.groupId);
    const replay = await previousOutcome(this.deps, customer.userId, 'group.cancelled', key, view.group.id);
    if (replay) return replay;
    return closeGroup(this.deps, {
      actorId: customer.userId,
      groupId: view.group.id,
      requests: view.requests,
      to: 'cancelled',
      reason: optionalText('reason', input.reason, 500),
      key,
      operation: 'group.cancelled',
    });
  }
}
