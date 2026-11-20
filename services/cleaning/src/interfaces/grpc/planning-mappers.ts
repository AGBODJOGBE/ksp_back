import { type cleaningV1 } from '@ksp/contracts';
import { type AgentCheckView, type AssignmentView } from '../../application/planning/assignment-support';
import { type AssignmentBatchView } from '../../application/planning/assignment.use-cases';
import { type AgentAssignmentRecord } from '../../application/planning/planning.ports';
import {
  type AgentLoadView,
  type PlanningItemView,
} from '../../application/planning/planning-view.use-cases';
import { type Page } from '../../application/shared/input';
import { splitName } from './agent-mappers';

/** Affectations, contrôles et planning → messages du contrat. */

export function toAgentCheck(check: AgentCheckView): cleaningV1.AgentCheck {
  return {
    agentId: check.agentId,
    target: check.target,
    passed: check.passed,
    results: check.results.map((r) => ({
      check: r.check,
      passed: r.passed,
      overridable: r.overridable,
      overridden: r.overridden,
      missingSkills: r.missingSkills,
      conflicts: r.conflicts,
      ...(r.unavailabilityId
        ? {
            unavailabilityId: r.unavailabilityId,
            unavailabilityStart: r.unavailabilityStart!,
            unavailabilityEnd: r.unavailabilityEnd!,
          }
        : {}),
    })),
  };
}

export function toAssignment(view: AssignmentView): cleaningV1.Assignment {
  const name = splitName(view.agentName);
  return {
    id: view.id,
    target: view.target,
    agentId: view.agentId,
    agentFirstName: name.firstName,
    agentLastName: name.lastName,
    isLead: view.isLead,
    source: view.source,
    status: view.status,
    ...(view.respondBefore ? { respondBefore: view.respondBefore } : {}),
    overrides: view.overrides,
    ...(view.createdBy ? { createdBy: view.createdBy } : {}),
    createdAt: view.createdAt,
    ...(view.createdByName ? { createdByName: view.createdByName } : {}),
  };
}

export function toAssignmentBatch(batch: AssignmentBatchView): cleaningV1.AssignmentBatch {
  return {
    assignments: batch.assignments.map(toAssignment),
    checks: batch.checks.map(toAgentCheck),
    warnings: batch.warnings,
    ...(batch.batchId ? { batchId: batch.batchId } : {}),
    skipped: batch.skipped.map(toAgentCheck),
  };
}

export function toAgentAssignmentView(record: AgentAssignmentRecord): cleaningV1.AgentAssignmentView {
  return {
    assignmentId: record.id,
    target: record.target,
    status: record.status,
    isLead: record.isLead,
    start: record.start.toISOString(),
    end: record.end.toISOString(),
    targetStatus: record.targetStatus,
    placeTypeName: record.placeTypeName,
    communeName: record.communeName,
    ...(record.respondBefore ? { respondBefore: record.respondBefore.toISOString() } : {}),
  };
}

export function toAgentAssignmentPage(
  page: Page<AgentAssignmentRecord>,
): cleaningV1.ListMyAssignmentsResponse {
  return {
    items: page.items.map(toAgentAssignmentView),
    nextCursor: page.nextCursor ?? '',
    total: page.total,
  };
}

/**
 * Visite ou séance au planning. La position du lieu (carte du jour) n'est pas rendue : son
 * déchiffrement relève du lot C ; champ location absent.
 */
export function toPlanningItem(item: PlanningItemView): cleaningV1.PlanningItem {
  const { record } = item;
  return {
    kind: record.target.kind,
    id: record.target.id,
    number: record.number,
    ...(record.rank !== null ? { rank: record.rank } : {}),
    status: record.status,
    start: record.start.toISOString(),
    end: record.end.toISOString(),
    communeKey: record.communeKey,
    communeName: record.communeName,
    cleaningTypes: record.cleaningTypes,
    requiredSkills: [...record.requiredSkills],
    teamSize: record.expectedTeamSize ?? 1,
    agents: item.agents.map((a) => ({
      agentId: a.agentId,
      ...splitName(a.name),
      isLead: a.isLead,
      confirmation: a.status,
    })),
    late: item.late,
    urgent: item.urgent,
  };
}

export function toAgentLoad(load: AgentLoadView): cleaningV1.AgentLoad {
  return {
    agentId: load.agentId,
    ...splitName(load.name),
    plannedMinutes: load.plannedMinutes,
    maxMinutes: load.maxMinutes,
  };
}
