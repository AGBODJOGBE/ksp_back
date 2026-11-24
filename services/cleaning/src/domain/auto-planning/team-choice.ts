import {
  type AgentCheck,
  checkTarget,
  type PlanningAgent,
  type PlanningContext,
  type TargetCheck,
} from '../planning/assignment-check';
import { type PlanningError } from '../planning/errors';
import { compareIds } from '../planning/order';
import { type AutoTarget } from './modes';
import {
  type CandidateScore,
  compareScores,
  type ProgramHistory,
  scoreCandidate,
  type ScoreWeights,
} from './score';

/**
 * Choix de l'équipe d'une séance par la planification automatique (R-PL-02, R-PL-04). Les contrôles
 * sont ceux de la planification manuelle (checkTarget), sans aucun contournement : l'automatique ne
 * force jamais. Le domaine ne fait qu'ordonner les candidats et essayer des équipes.
 */
export interface AutoAgent extends PlanningAgent {
  /** Aptitude à être chef d'équipe (Agent.canLead, R-PL-04). */
  canLead: boolean;
  /** Note moyenne des clients ; null sans note (AgentStats.rating_average). */
  ratingAverage: number | null;
}

/** Motif d'une séance restée « à affecter » (AutoPlanningFailure.reason, R-PL-06). */
export type FailureReason = 'no_candidate' | 'team_incomplete' | 'no_lead';

/**
 * Nombre d'équipes essayées au plus pour une séance. Le CDC ne le fixe pas : la borne garde le
 * passage rapide quand aucune équipe ne couvre les compétences.
 */
export const MAX_TEAM_ATTEMPTS = 200;

export type TeamChoice =
  | {
      ok: true;
      /** Contrôles de l'équipe retenue, agents dans l'ordre du classement. */
      check: TargetCheck;
      /** Scores de tous les candidats, du meilleur au moins bon. */
      ranking: CandidateScore[];
    }
  | {
      ok: false;
      reason: FailureReason;
      /** Motifs de refus de la meilleure équipe essayée (ou de l'ensemble des candidats). */
      errors: PlanningError[];
      /** Agents écartés par leurs contrôles individuels, avec leurs contrôles. */
      rejected: AgentCheck[];
      ranking: CandidateScore[];
    };

/** Places à pourvoir : taille d'équipe prévue moins les agents déjà affectés (R-PL-07, « les trous »). */
export function missingAgents(target: AutoTarget): number {
  return (target.expectedTeamSize ?? 1) - target.assignedAgents.length;
}

/** Combinaisons de k rangs parmi n, dans l'ordre lexicographique. */
export function* combinations(n: number, k: number): Generator<number[]> {
  if (k > n) return;
  const indexes = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield [...indexes];
    let i = k - 1;
    while (i >= 0 && indexes[i] === n - k + i) i -= 1;
    if (i < 0) return;
    indexes[i] += 1;
    for (let j = i + 1; j < k; j += 1) indexes[j] = indexes[j - 1]! + 1;
  }
}

interface LeadCandidate {
  agent: Pick<AutoAgent, 'agentId' | 'ratingAverage'>;
  score: CandidateScore;
}

/**
 * Ordre des chefs possibles (R-PL-04, « le mieux noté ») : interprétation, « noté » se lit comme la
 * note moyenne des clients ; un agent noté passe avant un agent sans note ; puis le meilleur score,
 * puis l'identifiant.
 */
export function compareLeadCandidates(a: LeadCandidate, b: LeadCandidate): number {
  const ra = a.agent.ratingAverage;
  const rb = b.agent.ratingAverage;
  if (ra !== rb) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    return rb - ra;
  }
  return b.score.total - a.score.total || compareIds(a.agent.agentId, b.agent.agentId);
}

const leadMissing = (error: PlanningError) =>
  error.code === 'CLEANING_VALIDATION_FAILED' && error.details.field === 'leadAgentId';

/**
 * Équipe d'une séance :
 * 1. candidats : les agents qui passent tous leurs contrôles individuels (R-PL-02), lus dans le
 *    contrôle « équipe » de checkTarget ;
 * 2. classement par score (R-PL-03), départagé par l'identifiant ;
 * 3. équipes essayées dans l'ordre lexicographique des rangs : d'abord les meilleurs scores
 *    (R-PL-04), puis en remplaçant le moins bien classé ; chaque équipe est contrôlée par checkTarget
 *    avec son chef, et la première acceptée est retenue.
 * Interprétation prudente : quand les meilleurs scores ne couvrent pas les compétences (R-CA-09) ou
 * ne comptent aucun agent apte à être chef (R-EQ-03), l'automatique remplace le moins bien classé
 * plutôt que de laisser la séance sans équipe.
 */
export function chooseTeam(input: {
  target: AutoTarget;
  agents: readonly AutoAgent[];
  programHistory: ProgramHistory;
  weights: Readonly<ScoreWeights>;
  context: PlanningContext;
  maxAttempts?: number | undefined;
}): TeamChoice {
  const { target, context } = input;
  const byId = new Map(input.agents.map((agent) => [agent.agentId, agent]));
  const pool = checkTarget({
    target,
    // Ordre canonique : motifs et agents écartés ne dépendent pas de l'ordre reçu.
    agents: [...input.agents].sort((a, b) => compareIds(a.agentId, b.agentId)),
    mode: 'team',
    teamLeadId: null,
    leadAgentId: null,
    overrides: [],
    context,
  });
  const ranking = pool.agentChecks
    .map((agentCheck) =>
      scoreCandidate({
        agent: byId.get(agentCheck.agentId)!,
        target,
        programHistory: input.programHistory,
        travelMinutes: agentCheck.travelMinutes,
        now: context.now,
        weights: input.weights,
      }),
    )
    .sort(compareScores);
  const needed = missingAgents(target);
  const fail = (reason: FailureReason, errors: PlanningError[]): TeamChoice => ({
    ok: false,
    reason,
    errors,
    rejected: pool.signaled,
    ranking,
  });
  if (!ranking.length) return fail('no_candidate', pool.errors);
  if (ranking.length < needed) return fail('team_incomplete', pool.errors);

  const needLead = !target.assignedAgents.some((a) => a.isLead) && target.assignedAgents.length + needed > 1;
  let firstErrors: PlanningError[] | null = null;
  let onlyLeadMissing = false;
  let attempts = 0;
  for (const ranks of combinations(ranking.length, needed)) {
    if (attempts === (input.maxAttempts ?? MAX_TEAM_ATTEMPTS)) break;
    attempts += 1;
    const members = ranks.map((rank) => ({
      agent: byId.get(ranking[rank]!.agentId)!,
      score: ranking[rank]!,
    }));
    const lead = needLead
      ? (members.filter((m) => m.agent.canLead).sort(compareLeadCandidates)[0]?.agent.agentId ?? null)
      : null;
    const check = checkTarget({
      target,
      agents: members.map((m) => m.agent),
      mode: 'agents',
      teamLeadId: null,
      leadAgentId: lead,
      overrides: [],
      context,
    });
    if (check.passed) return { ok: true, check, ranking };
    firstErrors ??= check.errors;
    onlyLeadMissing ||= check.errors.every(leadMissing);
  }
  return fail(onlyLeadMissing ? 'no_lead' : 'team_incomplete', firstErrors ?? pool.errors);
}
