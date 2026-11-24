import { type AgendaEntry, travelFromMatrix } from '../planning/agenda';
import { type PlanningContext } from '../planning/assignment-check';
import { autoAssignmentState, type AutoPlanningInput, runAutoPlanning } from './auto-planning';
import { type AutoTarget } from './modes';
import { DEFAULT_SCORE_WEIGHTS, type ProgramHistory } from './score';
import { type AutoAgent } from './team-choice';

/** Programme déjà commencé : chaque séance réalisée faite par les mêmes agents. */
const doneBy = (agentIds: string[], sessions = 1): ProgramHistory => ({
  completed: { sessions, byAgent: Object.fromEntries(agentIds.map((id) => [id, sessions])) },
  inForce: { sessions: 0, byAgent: {} },
});

const at = (iso: string) => new Date(iso);
const h = (hours: number) => hours * 60;

const CONTEXT: PlanningContext = {
  now: at('2026-11-20T08:00:00+01:00'),
  travel: travelFromMatrix({ 'place-a': { 'place-b': 20 }, 'place-b': { 'place-a': 20 } }),
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
    canLead: true,
    ratingAverage: null,
    ...extra,
  };
}

/** Séance du programme p1, lundi 23 novembre 2026, de 9 h à 11 h (heure de Porto-Novo). */
function session(id: string, extra: Partial<AutoTarget> = {}): AutoTarget {
  return {
    target: { kind: 'session', id },
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

const day = (n: number, from: string, to: string) => ({
  start: at(`2026-11-${n}T${from}:00+01:00`),
  end: at(`2026-11-${n}T${to}:00+01:00`),
});

function input(targets: AutoTarget[], agents: AutoAgent[], extra: Partial<AutoPlanningInput> = {}) {
  const value: AutoPlanningInput = {
    targets,
    agents,
    programHistory: {},
    scope: {
      window: { start: CONTEXT.now, end: at('2026-12-04T08:00:00+01:00') },
      zoneKey: null,
      programId: null,
    },
    modes: { defaultMode: 'automatic', byZone: {} },
    weights: DEFAULT_SCORE_WEIGHTS,
    context: CONTEXT,
    ...extra,
  };
  return value;
}

/** Équipe de chaque séance retenue (identifiants triés : l'ordre de classement n'y compte pas). */
const teams = (result: ReturnType<typeof runAutoPlanning>) =>
  Object.fromEntries(result.proposals.map((p) => [p.target.id, p.assignments.map((a) => a.agentId).sort()]));

describe('R-PL-05 : propositions ou affectations appliquées selon le mode', () => {
  it('cas nominal (proposition) : affectations « proposed », sans échéance', () => {
    const result = runAutoPlanning(
      input([session('s1')], [agent('a1')], { modes: { defaultMode: 'proposal', byZone: {} } }),
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      target: { kind: 'session', id: 's1' },
      programId: 'p1',
      mode: 'proposal',
      assignments: [
        { agentId: 'a1', isLead: false, status: 'proposed', respondBefore: null, travelMinutes: 0 },
      ],
    });
  });

  it('automatique : confirmée d’office pour un salarié, en attente 12 h pour un indépendant (R-PL-08)', () => {
    const targets = [
      session('s1'),
      session('s2', { start: at('2026-11-24T09:00:00+01:00'), end: at('2026-11-24T11:00:00+01:00') }),
    ];
    const agents = [
      agent('a1', { unavailabilities: [{ id: 'u', reason: 'leave', ...day(24, '00:00', '23:59') }] }),
    ];
    agents.push(
      agent('a2', {
        employmentKind: 'independent',
        unavailabilities: [{ id: 'u', reason: 'other', ...day(23, '00:00', '23:59') }],
      }),
    );
    const result = runAutoPlanning(input(targets, agents));
    expect(result.proposals.map((p) => p.assignments[0])).toMatchObject([
      { agentId: 'a1', status: 'confirmed', respondBefore: null },
      { agentId: 'a2', status: 'pending_confirmation', respondBefore: at('2026-11-20T20:00:00+01:00') },
    ]);
  });

  it('cas limite : zone en mode manuel, rien n’est proposé ni signalé', () => {
    const result = runAutoPlanning(
      input([session('s1')], [agent('a1')], {
        modes: { defaultMode: 'automatic', byZone: { cotonou: 'manual' } },
      }),
    );
    expect(result).toEqual({ proposals: [], failures: [] });
  });
});

describe('statut des affectations de l’automatique', () => {
  it('proposition : « proposed » quel que soit l’agent ; automatique : statut des contrôles', () => {
    const agentCheck = runAutoPlanning(
      input([session('s1')], [agent('a1', { employmentKind: 'independent' })]),
    ).proposals[0]!.check.agentChecks[0]!;
    expect(autoAssignmentState('proposal', agentCheck)).toEqual({ status: 'proposed', respondBefore: null });
    expect(autoAssignmentState('automatic', agentCheck)).toEqual({
      status: 'pending_confirmation',
      respondBefore: at('2026-11-20T20:00:00+01:00'),
    });
  });
});

describe('R-PL-02 : l’automatique ne force jamais', () => {
  it('cas nominal : aucun contrôle contourné dans les affectations', () => {
    const result = runAutoPlanning(input([session('s1')], [agent('a1')]));
    expect(result.proposals[0]!.check.agentChecks.flatMap((c) => c.overridesUsed)).toEqual([]);
  });

  it('cas limite : seul candidat hors zone : séance laissée à affecter, avec le motif', () => {
    const result = runAutoPlanning(input([session('s1')], [agent('a1', { zoneKeys: ['ouidah'] })]));
    expect(result.proposals).toEqual([]);
    expect(result.failures).toMatchObject([{ target: { id: 's1' }, reason: 'no_candidate' }]);
    expect(result.failures[0]!.rejected[0]!.results.find((r) => r.check === 'zone')).toMatchObject({
      passed: false,
      overridden: false,
    });
  });
});

describe('R-PL-07 : ne déplace jamais une affectation faite, ne remplit que les trous', () => {
  const existing: AgendaEntry = {
    assignmentId: 'old',
    target: { kind: 'session', id: 'other' },
    placeId: 'place-b',
    ...day(23, '09:00', '11:00'),
    travelMinutes: 0,
    status: 'confirmed',
    respondBefore: null,
  };

  it('cas nominal : l’agent déjà pris garde son affectation, un autre est choisi', () => {
    const busy = agent('a1', { agenda: [existing], ratingAverage: 5 });
    const result = runAutoPlanning(
      input([session('s1')], [busy, agent('a2')], { programHistory: { p1: doneBy(['a1']) } }),
    );
    expect(teams(result)).toEqual({ s1: ['a2'] });
    expect(busy.agenda).toEqual([existing]);
  });

  it('cas limite : séance déjà en partie pourvue : seule la place libre est remplie', () => {
    const target = session('s1', {
      expectedTeamSize: 2,
      assignedAgents: [{ agentId: 'a1', validatedSkills: ['interior'], isLead: true }],
    });
    const result = runAutoPlanning(input([target], [agent('a1'), agent('a2'), agent('a3')]));
    expect(result.proposals[0]!.assignments).toMatchObject([{ agentId: 'a2', isLead: false }]);
  });

  it('cas limite : séance pleine (propositions en attente comprises) ou déjà planifiée : ignorée', () => {
    const full = session('s1', { assignedAgents: [{ agentId: 'a1', validatedSkills: [], isLead: false }] });
    const planned = session('s2', { status: 'assigned' });
    expect(runAutoPlanning(input([full, planned], [agent('a2')]))).toEqual({ proposals: [], failures: [] });
  });
});

describe('R-PL-11 et R-ZN-02 : chaque séance retenue occupe l’agenda pour les suivantes', () => {
  it('cas nominal : deux séances au même lieu, bout à bout : même agent, trajet nul', () => {
    const targets = [session('s1'), session('s2', day(23, '11:00', '12:00'))];
    const result = runAutoPlanning(input(targets, [agent('a1'), agent('a2')]));
    expect(teams(result)).toEqual({ s1: ['a1'], s2: ['a1'] });
    expect(result.proposals[1]!.assignments[0]!.travelMinutes).toBe(0);
  });

  it('cas limite : autre lieu, trajet de 20 min et 10 min d’écart : un autre agent', () => {
    const targets = [session('s1'), session('s2', { placeId: 'place-b', ...day(23, '11:10', '12:00') })];
    const result = runAutoPlanning(input(targets, [agent('a1'), agent('a2')]));
    expect(teams(result)).toEqual({ s1: ['a1'], s2: ['a2'] });
  });

  it('cas limite : trajet juste suffisant (20 min) : le même agent, trajet compté', () => {
    const targets = [session('s1'), session('s2', { placeId: 'place-b', ...day(23, '11:20', '12:00') })];
    const result = runAutoPlanning(input(targets, [agent('a1'), agent('a2')]));
    expect(teams(result)).toEqual({ s1: ['a1'], s2: ['a1'] });
    expect(result.proposals[1]!.assignments[0]).toMatchObject({
      travelMinutes: 20,
      occupied: day(23, '11:00', '12:00'),
    });
  });

  it('un seul agent pour deux séances simultanées : la seconde échoue sur le conflit', () => {
    const result = runAutoPlanning(input([session('s1'), session('s2')], [agent('a1')]));
    expect(teams(result)).toEqual({ s1: ['a1'] });
    expect(result.failures).toMatchObject([{ target: { id: 's2' }, reason: 'no_candidate' }]);
    const conflict = result.failures[0]!.rejected[0]!.results.find((r) => r.check === 'conflict')!;
    expect(conflict.conflicts.map((c) => c.target.id)).toEqual(['s1']);
  });

  it('la charge cumule les séances retenues du passage (R-DS-03)', () => {
    const targets = [session('s1', day(23, '06:00', '12:00')), session('s2', day(23, '13:00', '16:00'))];
    const result = runAutoPlanning(input(targets, [agent('a1')]));
    expect(teams(result)).toEqual({ s1: ['a1'] });
    expect(result.failures[0]!.rejected[0]!.results.find((r) => r.check === 'load')!.passed).toBe(false);
  });
});

describe('R-PL-04 et R-PL-03 : continuité de l’équipe au fil du passage', () => {
  it('cas nominal : l’équipe de la première séance est gardée pour les suivantes', () => {
    const targets = [23, 24, 25].map((n) =>
      session(`s${n}`, { expectedTeamSize: 2, ...day(n, '09:00', '11:00') }),
    );
    // a3 et a4 sont mieux notés, mais a1 et a2 sont déjà venus sur le programme.
    const agents = [
      agent('a3', { ratingAverage: 5 }),
      agent('a4', { ratingAverage: 5 }),
      agent('a1'),
      agent('a2'),
    ];
    const result = runAutoPlanning(input(targets, agents, { programHistory: { p1: doneBy(['a1', 'a2']) } }));
    expect(teams(result)).toEqual({ s23: ['a1', 'a2'], s24: ['a1', 'a2'], s25: ['a1', 'a2'] });
    expect(result.proposals.map((p) => p.check.leadAgentId)).toEqual(['a1', 'a1', 'a1']);
  });

  it('cas limite : un membre en congé est remplacé ce jour-là, puis l’équipe revient', () => {
    const targets = [23, 24, 25].map((n) =>
      session(`s${n}`, { expectedTeamSize: 2, ...day(n, '09:00', '11:00') }),
    );
    const agents = [
      agent('a1', { ratingAverage: 4 }),
      agent('a2', {
        ratingAverage: 4,
        unavailabilities: [{ id: 'u', reason: 'sickness', ...day(24, '00:00', '23:00') }],
      }),
      agent('a3', { ratingAverage: 3 }),
    ];
    const result = runAutoPlanning(input(targets, agents, { programHistory: { p1: doneBy(['a1', 'a2']) } }));
    expect(teams(result)).toEqual({ s23: ['a1', 'a2'], s24: ['a1', 'a3'], s25: ['a1', 'a2'] });
  });

  it('les agents retenus d’un programme ne comptent pas pour un autre programme', () => {
    const targets = [
      session('s1', { programId: 'p1' }),
      session('s2', { programId: 'p2', ...day(24, '09:00', '11:00') }),
    ];
    const agents = [agent('a1', { ratingAverage: 2 }), agent('a2', { ratingAverage: 4 })];
    const result = runAutoPlanning(input(targets, agents, { programHistory: { p1: doneBy(['a1']) } }));
    expect(teams(result)).toEqual({ s1: ['a1'], s2: ['a2'] });
  });
});

describe('déterminisme', () => {
  it('mêmes entrées dans un autre ordre : même résultat', () => {
    const targets = [23, 24, 25, 26].flatMap((n) => [
      session(`m${n}`, { expectedTeamSize: 2, ...day(n, '08:00', '10:00') }),
      session(`n${n}`, { programId: 'p2', placeId: 'place-b', ...day(n, '10:00', '12:00') }),
    ]);
    const agents = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => agent(id));
    const first = runAutoPlanning(input(targets, agents));
    const second = runAutoPlanning(input([...targets].reverse(), [...agents].reverse()));
    expect(second).toEqual(first);
    expect(first.failures).toEqual([]);
  });
});
