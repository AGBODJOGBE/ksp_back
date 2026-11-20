import { travelFromMatrix } from '../planning/agenda';
import { type PlanningContext } from '../planning/assignment-check';
import { type AutoTarget } from './modes';
import { DEFAULT_SCORE_WEIGHTS } from './score';
import {
  type AutoAgent,
  chooseTeam,
  combinations,
  compareLeadCandidates,
  MAX_TEAM_ATTEMPTS,
  missingAgents,
  type TeamChoice,
} from './team-choice';

const at = (iso: string) => new Date(iso);
const h = (hours: number) => hours * 60;

const CONTEXT: PlanningContext = {
  now: at('2026-11-20T08:00:00+01:00'),
  travel: travelFromMatrix({}),
  defaultTravelMinutes: 30,
  assignmentResponseHours: 12,
};

function agent(agentId: string, extra: Partial<AutoAgent> = {}): AutoAgent {
  return {
    agentId,
    status: 'active',
    employmentKind: 'employee',
    validatedSkills: ['interior'],
    zoneKeys: ['cotonou'],
    weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: h(6), endMinute: h(22) })),
    extras: [],
    unavailabilities: [],
    maxHoursPerDay: 8,
    maxHoursPerWeek: 48,
    agenda: [],
    canLead: false,
    ratingAverage: null,
    ...extra,
  };
}

function session(extra: Partial<AutoTarget> = {}): AutoTarget {
  return {
    target: { kind: 'session', id: 's1' },
    programId: 'p1',
    status: 'to_assign',
    placeId: 'place-a',
    communeKey: 'cotonou',
    start: at('2026-11-23T09:00:00+01:00'),
    end: at('2026-11-23T11:00:00+01:00'),
    requiredSkills: ['interior'],
    expectedTeamSize: 1,
    assignedAgents: [],
    ...extra,
  };
}

function choose(target: AutoTarget, agents: AutoAgent[], history: string[] = [], maxAttempts?: number) {
  return chooseTeam({
    target,
    agents,
    programAgentIds: new Set(history),
    weights: DEFAULT_SCORE_WEIGHTS,
    context: CONTEXT,
    maxAttempts,
  });
}

function chosen(choice: TeamChoice) {
  if (!choice.ok) throw new Error(`échec inattendu : ${choice.reason}`);
  return { agentIds: choice.check.agentIds, lead: choice.check.leadAgentId };
}

function failure(choice: TeamChoice) {
  if (choice.ok) throw new Error('affectation inattendue');
  return choice;
}

describe('R-PL-02 : seuls les agents qui passent tous les contrôles sont candidats', () => {
  it('cas nominal : un agent qui passe tout est retenu', () => {
    expect(chosen(choose(session(), [agent('a1')]))).toEqual({ agentIds: ['a1'], lead: null });
  });

  it('cas limite : hors zone ou hors plages (contournables) : jamais forcé, l’autre agent est retenu', () => {
    const agents = [
      agent('a1', { zoneKeys: ['ouidah'], ratingAverage: 5 }),
      agent('a2', { weekly: [], ratingAverage: 5 }),
      agent('a3'),
    ];
    const choice = choose(session(), agents, ['a1', 'a2']);
    expect(chosen(choice).agentIds).toEqual(['a3']);
  });

  it('cas limite : agent en congé (RV-01) ou suspendu : aucun candidat, motifs rendus', () => {
    const leave = { id: 'u1', reason: 'leave' as const, start: CONTEXT.now, end: at('2026-12-01T00:00:00Z') };
    const result = failure(
      choose(session(), [agent('a1', { unavailabilities: [leave] }), agent('a2', { status: 'suspended' })]),
    );
    expect(result.reason).toBe('no_candidate');
    expect(
      result.rejected.map((c) => [c.agentId, c.results.filter((r) => !r.passed).map((r) => r.check)]),
    ).toEqual([
      ['a1', ['unavailability']],
      ['a2', ['active']],
    ]);
    expect(result.errors.map((e) => e.code)).toEqual(['CLEANING_VALIDATION_FAILED']);
  });

  it('les agents déjà affectés à la cible ne sont pas candidats (R-PL-07)', () => {
    const target = session({
      expectedTeamSize: 2,
      assignedAgents: [{ agentId: 'a1', validatedSkills: ['interior'], isLead: true }],
    });
    expect(chosen(choose(target, [agent('a1'), agent('a2')]))).toEqual({ agentIds: ['a2'], lead: null });
  });
});

describe('R-PL-04 : les meilleurs scores jusqu’à la taille d’équipe', () => {
  it('cas nominal : les deux meilleurs scores, le chef parmi eux', () => {
    const agents = [agent('a1'), agent('a2', { canLead: true }), agent('a3', { canLead: true })];
    // a3 et a2 sont déjà venus sur le programme (continuité).
    expect(chosen(choose(session({ expectedTeamSize: 2 }), agents, ['a2', 'a3']))).toEqual({
      agentIds: ['a2', 'a3'],
      lead: 'a2',
    });
  });

  it('cas limite : places manquantes seulement (trou), compté sur les agents déjà affectés', () => {
    const target = session({
      expectedTeamSize: 3,
      assignedAgents: [{ agentId: 'x', validatedSkills: [], isLead: false }],
    });
    expect(missingAgents(target)).toBe(2);
    expect(missingAgents(session({ expectedTeamSize: null }))).toBe(1);
  });

  it('cas limite : moins de candidats que de places : équipe incomplète, rien n’est affecté', () => {
    const result = failure(choose(session({ expectedTeamSize: 2 }), [agent('a1', { canLead: true })]));
    expect(result.reason).toBe('team_incomplete');
    expect(result.errors.map((e) => e.code)).toContain('CLEANING_TEAM_SIZE_MISMATCH');
    expect(result.ranking.map((s) => s.agentId)).toEqual(['a1']);
  });

  it('compétences : l’équipe réunie doit les couvrir (R-CA-09) ; le moins bien classé est remplacé', () => {
    const target = session({ expectedTeamSize: 2, requiredSkills: ['interior', 'windows'] });
    const agents = [
      agent('a1', { canLead: true }),
      agent('a2'),
      agent('a3', { validatedSkills: ['windows'] }),
    ];
    expect(chosen(choose(target, agents, ['a1', 'a2']))).toEqual({ agentIds: ['a1', 'a3'], lead: 'a1' });
  });

  it('cas limite : compétence que personne n’a : équipe incomplète, avec le motif', () => {
    const target = session({ requiredSkills: ['glass'] });
    const result = failure(choose(target, [agent('a1'), agent('a2')]));
    expect(result.reason).toBe('team_incomplete');
    expect(result.errors.map((e) => e.code)).toEqual(['CLEANING_SKILL_MISSING']);
  });

  it(`essais bornés (${MAX_TEAM_ATTEMPTS} par défaut) : au-delà, équipe incomplète`, () => {
    const target = session({ requiredSkills: ['windows'] });
    const agents = [agent('a1'), agent('a2', { validatedSkills: ['windows'] })];
    expect(chosen(choose(target, agents)).agentIds).toEqual(['a2']);
    expect(failure(choose(target, agents, [], 1)).reason).toBe('team_incomplete');
    // Aucun essai permis : les motifs de l'ensemble des candidats réunis sont rendus.
    expect(failure(choose(target, agents, [], 0)).reason).toBe('team_incomplete');
  });
});

describe('R-PL-04 et R-EQ-03 : le chef est le mieux noté parmi ceux qui en ont l’aptitude', () => {
  it('cas nominal : le mieux noté des aptes, même s’il a un moins bon score', () => {
    const agents = [
      agent('a1', { canLead: true, ratingAverage: 3 }),
      agent('a2', { canLead: true, ratingAverage: 4.5 }),
      agent('a3', { ratingAverage: 5 }),
    ];
    const choice = choose(session({ expectedTeamSize: 3 }), agents, ['a1']);
    expect(chosen(choice)).toEqual({ agentIds: ['a1', 'a3', 'a2'], lead: 'a2' });
  });

  it('cas limite : aucun apte parmi les meilleurs scores : le moins bien classé laisse sa place à un apte', () => {
    const agents = [agent('a1'), agent('a2'), agent('a3', { canLead: true })];
    expect(chosen(choose(session({ expectedTeamSize: 2 }), agents, ['a1', 'a2']))).toEqual({
      agentIds: ['a1', 'a3'],
      lead: 'a3',
    });
  });

  it('cas limite : aucun apte du tout : « no_lead », motif leadAgentId', () => {
    const result = failure(choose(session({ expectedTeamSize: 2 }), [agent('a1'), agent('a2')]));
    expect(result.reason).toBe('no_lead');
    expect(result.errors).toEqual([
      { code: 'CLEANING_VALIDATION_FAILED', details: { field: 'leadAgentId', reason: 'required' } },
    ]);
  });

  it('un seul agent, ou un chef déjà en place : pas de chef à désigner', () => {
    expect(chosen(choose(session(), [agent('a1', { canLead: true })])).lead).toBeNull();
    const target = session({
      expectedTeamSize: 2,
      assignedAgents: [{ agentId: 'x', validatedSkills: ['interior'], isLead: true }],
    });
    expect(chosen(choose(target, [agent('a1', { canLead: true })])).lead).toBeNull();
  });

  it('départage : note, puis agent noté avant non noté, puis score, puis identifiant', () => {
    const lead = (agentId: string, ratingAverage: number | null, total: number) => ({
      agent: { agentId, ratingAverage },
      score: { agentId, total, continuity: 0, proximity: 0, balance: 0, rating: 0 },
    });
    const order = [lead('d', null, 90), lead('c', 4, 10), lead('b', 4, 50), lead('a', 4, 50), lead('e', 5, 0)]
      .sort(compareLeadCandidates)
      .map((c) => c.agent.agentId);
    expect(order).toEqual(['e', 'a', 'b', 'c', 'd']);
  });
});

describe('combinaisons essayées', () => {
  it('ordre lexicographique des rangs : les meilleurs d’abord, le dernier remplacé en premier', () => {
    expect([...combinations(4, 2)]).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  it('cas limite : k = n donne une seule combinaison ; k > n aucune', () => {
    expect([...combinations(2, 2)]).toEqual([[0, 1]]);
    expect([...combinations(1, 2)]).toEqual([]);
  });
});
