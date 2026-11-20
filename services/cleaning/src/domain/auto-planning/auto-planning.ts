import { type TargetRef } from '../planning/agenda';
import { agendaEntriesFor } from '../planning/assignment-batch';
import { type AgentCheck, type PlanningContext, type TargetCheck } from '../planning/assignment-check';
import { type AssignmentState } from '../planning/assignment-status';
import { type PlanningError } from '../planning/errors';
import { type Period } from '../planning/time';
import { type AutoTarget, type PlanningMode, selectTargets, type TargetScope, type ZoneModes } from './modes';
import { type CandidateScore, type ScoreWeights } from './score';
import { type AutoAgent, chooseTeam, type FailureReason, missingAgents } from './team-choice';

/**
 * Passage de la planification automatique (9.5, R-PL-01 à R-PL-07, RunAutoPlanning). Domaine pur :
 * l'heure (context.now), les agents et leur agenda relu sous verrou (RV-75), les séances et les
 * réglages sont fournis par l'appelant. Le passage ne modifie pas ses entrées.
 */
export interface AutoPlanningInput {
  /** Séances candidates ; seules les séances « à affecter » de la période sont traitées. */
  targets: readonly AutoTarget[];
  agents: readonly AutoAgent[];
  /**
   * Agents déjà venus sur chaque programme (continuité, R-PL-03). Les agents retenus par le passage
   * s'y ajoutent pour les séances suivantes du même programme.
   */
  programAgents: Readonly<Record<string, readonly string[]>>;
  scope: Omit<TargetScope, 'now'>;
  modes: ZoneModes;
  weights: Readonly<ScoreWeights>;
  context: PlanningContext;
}

export type AutoMode = Exclude<PlanningMode, 'manual'>;

/** Affectation à écrire (source « auto », created_by null). */
export interface ProposedAssignment extends AssignmentState {
  agentId: string;
  isLead: boolean;
  /** Trajet compté avant la séance et période occupée (assignments.travel_minutes, occupied_*). */
  travelMinutes: number;
  occupied: Period;
  score: CandidateScore;
}

/** Équipe retenue pour une séance : proposée (mode proposition) ou appliquée (mode automatique). */
export interface AutoProposal {
  target: TargetRef;
  programId: string;
  mode: AutoMode;
  assignments: ProposedAssignment[];
  /** Contrôles de checkTarget sur l'agenda du passage, tous passés. */
  check: TargetCheck;
}

/** Séance restée « à affecter » (R-PL-06), avec ses motifs. */
export interface AutoFailure {
  target: TargetRef;
  programId: string;
  mode: AutoMode;
  reason: FailureReason;
  errors: PlanningError[];
  /** Agents écartés par leurs contrôles individuels. */
  rejected: AgentCheck[];
}

export interface AutoPlanningResult {
  /** Dans l'ordre de traitement (chronologique). */
  proposals: AutoProposal[];
  failures: AutoFailure[];
}

/**
 * Statut d'une affectation de l'automatique : « proposed » en mode proposition (R-PL-05, la
 * proposition occupe l'agenda) ; en mode automatique, celui de l'affectation enregistrée (R-PL-08 :
 * confirmée pour un salarié, en attente pour un indépendant).
 */
export function autoAssignmentState(mode: AutoMode, agentCheck: AgentCheck): AssignmentState {
  if (mode === 'proposal') return { status: 'proposed', respondBefore: null };
  return { status: agentCheck.status, respondBefore: agentCheck.respondBefore };
}

/**
 * Passage : les séances sont traitées dans l'ordre chronologique (départage : type, identifiant) ;
 * chaque équipe retenue occupe l'agenda de ses agents, trajet compris, pour les séances suivantes
 * (R-PL-11), et compte pour la continuité de son programme. Aucune affectation existante n'est
 * touchée (R-PL-07) : seules les places manquantes sont pourvues.
 */
export function runAutoPlanning(input: AutoPlanningInput): AutoPlanningResult {
  const { context } = input;
  const agents = new Map(
    input.agents.map((agent) => [agent.agentId, { ...agent, agenda: [...agent.agenda] }]),
  );
  const roster = [...agents.values()];
  const programAgents = new Map<string, Set<string>>();
  const historyOf = (programId: string) => {
    let history = programAgents.get(programId);
    if (!history) {
      history = new Set(input.programAgents[programId] ?? []);
      programAgents.set(programId, history);
    }
    return history;
  };

  const proposals: AutoProposal[] = [];
  const failures: AutoFailure[] = [];
  const selected = selectTargets(input.targets, { ...input.scope, now: context.now }, input.modes);
  for (const { target, mode } of selected) {
    if (missingAgents(target) <= 0) continue;
    const history = historyOf(target.programId);
    const choice = chooseTeam({
      target,
      agents: roster,
      programAgentIds: history,
      weights: input.weights,
      context,
    });
    const ref = { target: target.target, programId: target.programId, mode };
    if (!choice.ok) {
      failures.push({ ...ref, reason: choice.reason, errors: choice.errors, rejected: choice.rejected });
      continue;
    }
    const scores = new Map(choice.ranking.map((score) => [score.agentId, score]));
    const rows = agendaEntriesFor(choice.check, target);
    const assignments = choice.check.agentChecks.map((agentCheck, index): ProposedAssignment => {
      const state = autoAssignmentState(mode, agentCheck);
      const row = rows[index]!;
      agents.get(agentCheck.agentId)!.agenda.push({ ...row.entry, ...state });
      history.add(agentCheck.agentId);
      return {
        agentId: agentCheck.agentId,
        isLead: row.isLead,
        ...state,
        travelMinutes: agentCheck.travelMinutes,
        occupied: agentCheck.occupied,
        score: scores.get(agentCheck.agentId)!,
      };
    });
    proposals.push({ ...ref, assignments, check: choice.check });
  }
  return { proposals, failures };
}
