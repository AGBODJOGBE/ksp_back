import { type TargetRef } from '../planning/agenda';
import { planAssignments } from '../planning/assignment-batch';
import { type PlanningAgent, type PlanningContext, type PlanningTarget } from '../planning/assignment-check';
import { type AssignmentState, effectiveAssignmentStatus } from '../planning/assignment-status';
import { type PlanningError, planningError } from '../planning/errors';
import { comparePlanningOrder } from '../planning/order';
import { type Period } from '../planning/time';

/**
 * Validation des propositions par le superviseur (R-PL-05, ApproveProposals) : les contrôles de 9.4
 * sont refaits sous verrou, par l'affectation en lot de la planification manuelle, sans aucun
 * contournement. Une proposition devenue impossible est signalée et ignorée ; elle reste proposée.
 * Pour modifier une proposition, le superviseur la retire et affecte à la main (contrat).
 */
export interface ProposalRow extends AssignmentState {
  assignmentId: string;
  agentId: string;
  isLead: boolean;
}

export interface ApprovalTarget {
  /** Cible relue sous verrou ; assignedAgents compte toutes ses affectations en vigueur, propositions comprises. */
  target: PlanningTarget;
  /** Propositions de cette cible à valider. */
  proposals: readonly ProposalRow[];
}

/** Proposition validée : statut de l'affectation enregistrée (R-PL-08) et agenda recalculé. */
export interface ApprovedAssignment extends AssignmentState {
  assignmentId: string;
  agentId: string;
  isLead: boolean;
  travelMinutes: number;
  occupied: Period;
}

export interface IgnoredProposals {
  target: TargetRef;
  assignmentIds: string[];
  errors: PlanningError[];
}

export interface ApprovalOutcome {
  approved: ApprovedAssignment[];
  ignored: IgnoredProposals[];
}

/**
 * Validation, cible par cible dans l'ordre chronologique. Les propositions d'une même cible sont
 * contrôlées ensemble (taille d'équipe, compétences, chef) : si l'équipe ne passe plus, toutes sont
 * ignorées. Une ligne qui n'est plus « proposed » est ignorée seule.
 */
export function approveProposals(input: {
  targets: readonly ApprovalTarget[];
  agents: readonly PlanningAgent[];
  context: PlanningContext;
}): ApprovalOutcome {
  const { context } = input;
  const agents = new Map(input.agents.map((agent) => [agent.agentId, agent]));
  const outcome: ApprovalOutcome = { approved: [], ignored: [] };
  const ordered = [...input.targets].sort((a, b) => comparePlanningOrder(a.target, b.target));
  for (const { target, proposals } of ordered) {
    const stale = proposals.filter((row) => effectiveAssignmentStatus(row, context.now) !== 'proposed');
    for (const row of stale) {
      const from = effectiveAssignmentStatus(row, context.now);
      outcome.ignored.push({
        target: target.target,
        assignmentIds: [row.assignmentId],
        errors: [planningError('CLEANING_INVALID_TRANSITION', { from, to: 'confirmed' })],
      });
    }
    const rows = proposals.filter((row) => !stale.includes(row));
    if (!rows.length) continue;
    const approving = new Set(rows.map((row) => row.agentId));
    const batch = planAssignments(
      {
        targets: [
          { ...target, assignedAgents: target.assignedAgents.filter((a) => !approving.has(a.agentId)) },
        ],
        agents: rows.flatMap((row) => agents.get(row.agentId) ?? []),
        team: null,
        leadAgentId: rows.find((row) => row.isLead)?.agentId ?? null,
        overrides: [],
        skipFailing: true,
      },
      context,
    );
    const check = batch.retained[0];
    if (!check) {
      outcome.ignored.push({
        target: target.target,
        assignmentIds: rows.map((row) => row.assignmentId),
        errors: batch.errors,
      });
      continue;
    }
    for (const agentCheck of check.agentChecks) {
      const row = rows.find((r) => r.agentId === agentCheck.agentId)!;
      outcome.approved.push({
        assignmentId: row.assignmentId,
        agentId: row.agentId,
        isLead: row.isLead,
        status: agentCheck.status,
        respondBefore: agentCheck.respondBefore,
        travelMinutes: agentCheck.travelMinutes,
        occupied: agentCheck.occupied,
      });
    }
  }
  return outcome;
}
