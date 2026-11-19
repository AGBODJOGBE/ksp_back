import { type TeamRuleBracket } from './types';

/**
 * Taille d'équipe et durée d'une séance (R-CA-10, R-CA-13). La règle d'une offre est faite de
 * tranches de superficie contiguës : la première commence à 0, la dernière est ouverte. Une règle
 * vide est permise : l'offre compte alors pour 1 agent et la durée de référence de son type.
 */
export const MIN_AGENTS = 1;
export const MAX_AGENTS = 50;
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 1440;

export interface TeamRuleProblem {
  field: string;
  reason: 'team_rule_gap' | 'out_of_range';
}

export interface OfferTeam {
  agents: number;
  durationMinutes: number;
}

export interface TeamProposal {
  teamSize: number;
  durationMinutes: number;
}

const inRange = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

/** Défauts d'une règle d'équipe (`team_rule_gap` pour toute rupture de la contiguïté). */
export function teamRuleProblems(rule: readonly TeamRuleBracket[]): TeamRuleProblem[] {
  const problems: TeamRuleProblem[] = [];
  rule.forEach((bracket, index) => {
    const last = index === rule.length - 1;
    const previous = index === 0 ? null : (rule[index - 1] as TeamRuleBracket);
    const expectedFrom = previous === null ? 0 : previous.toArea === null ? null : previous.toArea + 1;
    const closedWell = bracket.toArea === null ? last : !last && bracket.toArea >= bracket.fromArea;
    if (bracket.fromArea !== expectedFrom || !closedWell) {
      problems.push({ field: `teamRule[${index}]`, reason: 'team_rule_gap' });
    }
    if (!inRange(bracket.agents, MIN_AGENTS, MAX_AGENTS)) {
      problems.push({ field: `teamRule[${index}].agents`, reason: 'out_of_range' });
    }
    if (!inRange(bracket.durationMinutes, MIN_DURATION_MINUTES, MAX_DURATION_MINUTES)) {
      problems.push({ field: `teamRule[${index}].durationMinutes`, reason: 'out_of_range' });
    }
  });
  return problems;
}

/** Équipe d'une offre pour une superficie ; repli : 1 agent et la durée de référence du type. */
export function offerTeam(
  rule: readonly TeamRuleBracket[],
  area: number | null,
  referenceDurationMinutes: number,
): OfferTeam {
  const bracket =
    area === null
      ? undefined
      : rule.find(
          (candidate) =>
            area >= candidate.fromArea && (candidate.toArea === null || area <= candidate.toArea),
        );
  if (!bracket) return { agents: 1, durationMinutes: referenceDurationMinutes };
  return { agents: bracket.agents, durationMinutes: bracket.durationMinutes };
}

/** Équipe d'une séance : maximum des agents et somme des durées des offres choisies. */
export function proposeTeam(
  offers: readonly { teamRule: readonly TeamRuleBracket[]; referenceDurationMinutes: number }[],
  area: number | null,
): TeamProposal | null {
  if (!offers.length) return null;
  const teams = offers.map((offer) => offerTeam(offer.teamRule, area, offer.referenceDurationMinutes));
  return {
    teamSize: Math.max(...teams.map((team) => team.agents)),
    durationMinutes: teams.reduce((total, team) => total + team.durationMinutes, 0),
  };
}
