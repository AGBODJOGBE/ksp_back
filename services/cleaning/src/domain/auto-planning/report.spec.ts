import { travelFromMatrix } from '../planning/agenda';
import { type PlanningContext } from '../planning/assignment-check';
import { runAutoPlanning } from './auto-planning';
import { type AutoTarget } from './modes';
import { autoPlanningReport } from './report';
import { DEFAULT_SCORE_WEIGHTS } from './score';
import { type AutoAgent } from './team-choice';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T08:00:00+01:00');
const WINDOW = { start: NOW, end: at('2026-12-04T08:00:00+01:00') };

const CONTEXT: PlanningContext = {
  now: NOW,
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
    zoneKeys: ['cotonou', 'porto-novo'],
    weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 360, endMinute: 1320 })),
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

function session(id: string, dayOfMonth: number, extra: Partial<AutoTarget> = {}): AutoTarget {
  return {
    target: { kind: 'session', id },
    programId: 'p1',
    status: 'to_assign',
    placeId: 'place-a',
    communeKey: 'cotonou',
    start: at(`2026-11-${dayOfMonth}T09:00:00+01:00`),
    end: at(`2026-11-${dayOfMonth}T11:00:00+01:00`),
    requiredSkills: ['interior'],
    expectedTeamSize: 2,
    assignedAgents: [],
    ...extra,
  };
}

function run(targets: AutoTarget[], agents: AutoAgent[]) {
  return runAutoPlanning({
    targets,
    agents,
    programAgents: {},
    scope: { window: WINDOW, zoneKey: null, programId: null },
    modes: { defaultMode: 'automatic', byZone: { 'porto-novo': 'proposal' } },
    weights: DEFAULT_SCORE_WEIGHTS,
    context: CONTEXT,
  });
}

describe('rapport du passage (AutoPlanningRun, R-PL-06)', () => {
  const targets = [
    session('s1', 23),
    session('s2', 24, { communeKey: 'porto-novo' }),
    // Samedi : aucun agent n'est disponible.
    session('s3', 28),
    // Compétence que personne n'a.
    session('s4', 25, { requiredSkills: ['glass'] }),
  ];
  const report = autoPlanningReport(run(targets, [agent('a1'), agent('a2')]), WINDOW, NOW);

  it('cas nominal : cibles affectées et proposées, affectations comptées par mode', () => {
    expect(report).toMatchObject({
      from: WINDOW.start,
      to: WINDOW.end,
      startedAt: NOW,
      assigned: 2,
      proposed: 2,
    });
    expect(report.targets).toEqual([
      {
        target: { kind: 'session', id: 's1' },
        programId: 'p1',
        mode: 'automatic',
        agentIds: ['a1', 'a2'],
        leadAgentId: 'a1',
      },
      {
        target: { kind: 'session', id: 's2' },
        programId: 'p1',
        mode: 'proposal',
        agentIds: ['a1', 'a2'],
        leadAgentId: 'a1',
      },
    ]);
  });

  it('cibles impossibles : motif du contrat, codes d’erreur et contrôles en échec de chaque agent', () => {
    expect(report.failures).toEqual([
      {
        target: { kind: 'session', id: 's4' },
        programId: 'p1',
        mode: 'automatic',
        reason: 'team_incomplete',
        errors: [expect.objectContaining({ code: 'CLEANING_SKILL_MISSING' })],
        rejectedAgents: [],
      },
      {
        target: { kind: 'session', id: 's3' },
        programId: 'p1',
        mode: 'automatic',
        reason: 'no_candidate',
        errors: [expect.objectContaining({ code: 'CLEANING_VALIDATION_FAILED' })],
        rejectedAgents: [
          { agentId: 'a1', checks: ['availability'] },
          { agentId: 'a2', checks: ['availability'] },
        ],
      },
    ]);
    expect(report.supervisorAlert).toBe(true);
  });

  it('cas limite : passage sans séance : rien d’affecté, aucune alerte', () => {
    const empty = autoPlanningReport(run([], [agent('a1')]), WINDOW, NOW);
    expect(empty).toEqual({
      from: WINDOW.start,
      to: WINDOW.end,
      startedAt: NOW,
      assigned: 0,
      proposed: 0,
      targets: [],
      failures: [],
      supervisorAlert: false,
    });
  });
});
