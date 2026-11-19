import { offerTeam, proposeTeam, teamRuleProblems } from './team';
import { type TeamRuleBracket } from './types';

const rule: TeamRuleBracket[] = [
  { fromArea: 0, toArea: 100, agents: 2, durationMinutes: 180 },
  { fromArea: 101, toArea: 300, agents: 3, durationMinutes: 240 },
  { fromArea: 301, toArea: null, agents: 4, durationMinutes: 300 },
];
const gap = (index: number) => ({ field: `teamRule[${index}]`, reason: 'team_rule_gap' });

describe('règle d’équipe d’une offre (R-CA-10, R-CA-13)', () => {
  it('accepte des tranches contiguës depuis 0, la dernière ouverte, et une règle vide', () => {
    expect(teamRuleProblems(rule)).toEqual([]);
    expect(teamRuleProblems([])).toEqual([]);
    expect(teamRuleProblems([{ fromArea: 0, toArea: null, agents: 1, durationMinutes: 15 }])).toEqual([]);
  });

  it('refuse une première tranche qui ne commence pas à 0', () => {
    expect(teamRuleProblems([{ ...rule[2]!, fromArea: 1 }])).toEqual([gap(0)]);
  });

  it('refuse un trou ou un chevauchement entre deux tranches', () => {
    expect(teamRuleProblems([rule[0]!, { ...rule[1]!, fromArea: 102 }, rule[2]!])).toEqual([gap(1)]);
    expect(teamRuleProblems([rule[0]!, { ...rule[1]!, fromArea: 100 }, rule[2]!])).toEqual([gap(1)]);
  });

  it('refuse une dernière tranche fermée et une tranche ouverte avant la dernière', () => {
    expect(teamRuleProblems([rule[0]!, rule[1]!])).toEqual([gap(1)]);
    expect(teamRuleProblems([{ ...rule[0]!, toArea: null }, rule[2]!])).toEqual([gap(0), gap(1)]);
  });

  it('refuse une tranche à l’envers, et des agents ou une durée hors bornes', () => {
    expect(teamRuleProblems([{ ...rule[0]!, toArea: -1 }, { ...rule[1]!, fromArea: 0 }, rule[2]!])).toEqual([
      gap(0),
    ]);
    expect(
      teamRuleProblems([
        { ...rule[0]!, agents: 0 },
        { ...rule[1]!, durationMinutes: 14 },
        { ...rule[2]!, agents: 51, durationMinutes: 1441 },
      ]),
    ).toEqual([
      { field: 'teamRule[0].agents', reason: 'out_of_range' },
      { field: 'teamRule[1].durationMinutes', reason: 'out_of_range' },
      { field: 'teamRule[2].agents', reason: 'out_of_range' },
      { field: 'teamRule[2].durationMinutes', reason: 'out_of_range' },
    ]);
  });
});

describe('équipe et durée proposées (R-CA-13)', () => {
  it('lit la tranche de la superficie, bornes incluses', () => {
    expect(offerTeam(rule, 100, 60)).toEqual({ agents: 2, durationMinutes: 180 });
    expect(offerTeam(rule, 101, 60)).toEqual({ agents: 3, durationMinutes: 240 });
    expect(offerTeam(rule, 0, 60)).toEqual({ agents: 2, durationMinutes: 180 });
    expect(offerTeam(rule, 1_000_000, 60)).toEqual({ agents: 4, durationMinutes: 300 });
  });

  it('compte 1 agent et la durée de référence sans superficie ou sans règle', () => {
    expect(offerTeam(rule, null, 90)).toEqual({ agents: 1, durationMinutes: 90 });
    expect(offerTeam([], 120, 90)).toEqual({ agents: 1, durationMinutes: 90 });
  });

  it('prend le maximum des agents et la somme des durées des offres choisies', () => {
    const vitres = [{ fromArea: 0, toArea: null, agents: 1, durationMinutes: 60 }];
    expect(
      proposeTeam(
        [
          { teamRule: rule, referenceDurationMinutes: 120 },
          { teamRule: vitres, referenceDurationMinutes: 45 },
          { teamRule: [], referenceDurationMinutes: 30 },
        ],
        120,
      ),
    ).toEqual({ teamSize: 3, durationMinutes: 240 + 60 + 30 });
  });

  it('ne propose rien sans offre', () => {
    expect(proposeTeam([], 120)).toBeNull();
  });
});
