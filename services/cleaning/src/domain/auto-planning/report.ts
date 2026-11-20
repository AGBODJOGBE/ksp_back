import { type TargetRef } from '../planning/agenda';
import { type CheckName } from '../planning/assignment-check';
import { type PlanningError } from '../planning/errors';
import { type Period } from '../planning/time';
import { type AutoMode, type AutoPlanningResult } from './auto-planning';
import { type FailureReason } from './team-choice';

/**
 * Rapport d'un passage (AutoPlanningRun) : séances pourvues, séances restées « à affecter » avec
 * leurs motifs (R-PL-06). L'adaptateur y ajoute l'identifiant du passage et écrit l'alerte.
 */
export interface AutoPlanningReport {
  from: Date;
  to: Date;
  startedAt: Date;
  /** Affectations appliquées (mode automatique). */
  assigned: number;
  /** Affectations proposées (mode proposition). */
  proposed: number;
  /** Séances pourvues, dans l'ordre de traitement. */
  targets: {
    target: TargetRef;
    programId: string;
    mode: AutoMode;
    agentIds: string[];
    leadAgentId: string | null;
  }[];
  /** Séances restées « à affecter » (AutoPlanningFailure), dans l'ordre de traitement. */
  failures: {
    target: TargetRef;
    programId: string;
    mode: AutoMode;
    reason: FailureReason;
    /** Motifs de refus, avec les codes du contrat. */
    errors: PlanningError[];
    /** Agents écartés et leurs contrôles en échec. */
    rejectedAgents: { agentId: string; checks: CheckName[] }[];
  }[];
  /** Au moins une séance sans équipe complète : alerte au superviseur (R-PL-06). */
  supervisorAlert: boolean;
}

export function autoPlanningReport(
  result: AutoPlanningResult,
  window: Period,
  startedAt: Date,
): AutoPlanningReport {
  const count = (mode: AutoMode) =>
    result.proposals.filter((p) => p.mode === mode).reduce((sum, p) => sum + p.assignments.length, 0);
  return {
    from: window.start,
    to: window.end,
    startedAt,
    assigned: count('automatic'),
    proposed: count('proposal'),
    targets: result.proposals.map((p) => ({
      target: p.target,
      programId: p.programId,
      mode: p.mode,
      agentIds: p.assignments.map((a) => a.agentId),
      leadAgentId: p.check.leadAgentId,
    })),
    failures: result.failures.map((f) => ({
      target: f.target,
      programId: f.programId,
      mode: f.mode,
      reason: f.reason,
      errors: f.errors,
      rejectedAgents: f.rejected.map((c) => ({
        agentId: c.agentId,
        checks: c.results.filter((r) => !r.passed).map((r) => r.check),
      })),
    })),
    supervisorAlert: result.failures.length > 0,
  };
}
