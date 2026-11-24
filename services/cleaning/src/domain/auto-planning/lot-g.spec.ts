import { type PlanningContext } from '../planning/assignment-check';
import { type DeclaredUnavailability } from '../planning/availability';
import { type AutoPlanningResult, runAutoPlanning } from './auto-planning';
import { type AutoTarget } from './modes';
import { DEFAULT_SCORE_WEIGHTS, type ProgramHistory } from './score';
import { type AutoAgent } from './team-choice';

/** Programme déjà commencé : chaque séance réalisée faite par les mêmes agents. */
const doneBy = (agentIds: string[], sessions = 1): ProgramHistory => ({
  completed: { sessions, byAgent: Object.fromEntries(agentIds.map((id) => [id, sessions])) },
  inForce: { sessions: 0, byAgent: {} },
});

/**
 * Critère du lot G (partie 18) : « Sur un jeu de 50 séances et 10 agents, l'automatique affecte
 * toutes les séances possibles sans conflit et garde la même équipe d'une séance à l'autre quand
 * elle est libre. » Les vérifications ci-dessous sont des oracles indépendants : elles relisent le
 * résultat sans passer par les contrôles du domaine.
 */
const at = (iso: string) => new Date(iso);
const MINUTE = 60_000;

/** Deux semaines ouvrées, du lundi 23 novembre au vendredi 4 décembre 2026. */
const DAYS = [
  '2026-11-23',
  '2026-11-24',
  '2026-11-25',
  '2026-11-26',
  '2026-11-27',
  '2026-11-30',
  '2026-12-01',
  '2026-12-02',
  '2026-12-03',
  '2026-12-04',
];

const TRAVEL: Record<string, Record<string, number>> = {
  'place-1': { 'place-2': 15, 'place-3': 40, 'place-4': 20, 'place-5': 45 },
  'place-2': { 'place-1': 15, 'place-3': 35, 'place-4': 25, 'place-5': 50 },
  'place-3': { 'place-1': 40, 'place-2': 35, 'place-4': 30, 'place-5': 60 },
  'place-4': { 'place-1': 20, 'place-2': 25, 'place-3': 30, 'place-5': 45 },
  'place-5': { 'place-1': 45, 'place-2': 50, 'place-3': 60, 'place-4': 45 },
};
const DEFAULT_TRAVEL = 30;
const travelBetween = (from: string, to: string) =>
  from === to ? 0 : (TRAVEL[from]?.[to] ?? DEFAULT_TRAVEL);

const CONTEXT: PlanningContext = {
  now: at('2026-11-20T08:00:00+01:00'),
  travel: (from, to) => TRAVEL[from]?.[to] ?? null,
  defaultTravelMinutes: DEFAULT_TRAVEL,
  assignmentResponseHours: 12,
};

/** Cinq programmes, une séance par jour ouvré chacun : 50 séances. */
const PROGRAMS = [
  {
    programId: 'p1',
    placeId: 'place-1',
    communeKey: 'cotonou',
    from: '08:00',
    to: '10:00',
    size: 1,
    skills: ['interior'],
  },
  {
    programId: 'p2',
    placeId: 'place-2',
    communeKey: 'cotonou',
    from: '08:00',
    to: '11:00',
    size: 2,
    skills: ['interior'],
  },
  {
    programId: 'p3',
    placeId: 'place-3',
    communeKey: 'abomey-calavi',
    from: '13:00',
    to: '16:00',
    size: 3,
    skills: ['interior', 'windows'],
  },
  {
    programId: 'p4',
    placeId: 'place-4',
    communeKey: 'cotonou',
    from: '14:00',
    to: '16:00',
    size: 2,
    skills: ['interior'],
  },
  {
    programId: 'p5',
    placeId: 'place-5',
    communeKey: 'porto-novo',
    from: '17:00',
    to: '19:00',
    size: 1,
    skills: ['interior'],
  },
];

const SESSIONS: AutoTarget[] = PROGRAMS.flatMap((p) =>
  DAYS.map((day) => ({
    target: { kind: 'session' as const, id: `${p.programId}-${day}` },
    programId: p.programId,
    status: 'to_assign',
    placeId: p.placeId,
    communeKey: p.communeKey,
    start: at(`${day}T${p.from}:00+01:00`),
    end: at(`${day}T${p.to}:00+01:00`),
    requiredSkills: p.skills,
    expectedTeamSize: p.size,
    assignedAgents: [],
  })),
);

const allDay = (id: string, day: string): DeclaredUnavailability => ({
  id,
  reason: 'leave',
  start: at(`${day}T00:00:00+01:00`),
  end: at(`${day}T23:59:00+01:00`),
});

function agent(agentId: string, zoneKeys: string[], extra: Partial<AutoAgent> = {}): AutoAgent {
  return {
    agentId,
    status: 'active',
    employmentKind: 'employee',
    validatedSkills: ['interior'],
    zoneKeys,
    weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 6 * 60, endMinute: 21 * 60 })),
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

const AGENTS: AutoAgent[] = [
  agent('a01', ['cotonou'], { canLead: true, ratingAverage: 4 }),
  agent('a02', ['cotonou'], { canLead: true, ratingAverage: 4.5 }),
  // Malade le mercredi 25 : remplacé ce jour-là sur p2.
  agent('a03', ['cotonou'], {
    ratingAverage: 4.8,
    unavailabilities: [{ ...allDay('u3', '2026-11-25'), reason: 'sickness' }],
  }),
  agent('a04', ['cotonou', 'abomey-calavi'], {
    validatedSkills: ['interior', 'windows'],
    canLead: true,
    ratingAverage: 4.2,
  }),
  agent('a05', ['abomey-calavi'], { validatedSkills: ['interior', 'windows'], ratingAverage: 3.9 }),
  agent('a06', ['abomey-calavi', 'cotonou'], { canLead: true, ratingAverage: 3.5 }),
  agent('a07', ['cotonou'], { canLead: true, employmentKind: 'independent' }),
  agent('a08', ['cotonou', 'abomey-calavi'], {
    validatedSkills: ['interior', 'windows'],
    ratingAverage: 4.1,
  }),
  // Seuls agents de Porto-Novo, tous deux en congé le vendredi 27 : la séance p5 de ce jour est impossible.
  agent('a09', ['porto-novo'], {
    canLead: true,
    ratingAverage: 4.4,
    unavailabilities: [allDay('u9', '2026-11-27')],
  }),
  agent('a10', ['porto-novo', 'cotonou'], {
    ratingAverage: 3,
    unavailabilities: [allDay('u10', '2026-11-27')],
  }),
];

const IMPOSSIBLE = ['p5-2026-11-27'];

function run(targets = SESSIONS, agents = AGENTS): AutoPlanningResult {
  return runAutoPlanning({
    targets,
    agents,
    // p1 et p2 ont déjà commencé : leurs équipes habituelles sont connues. p3 à p5 se forment au passage.
    programHistory: { p1: doneBy(['a01'], 3), p2: doneBy(['a02', 'a03'], 3) },
    scope: {
      window: { start: CONTEXT.now, end: at('2026-12-05T00:00:00+01:00') },
      zoneKey: null,
      programId: null,
    },
    modes: { defaultMode: 'automatic', byZone: {} },
    weights: DEFAULT_SCORE_WEIGHTS,
    context: CONTEXT,
  });
}

const sessionById = new Map(SESSIONS.map((s) => [s.target.id, s]));
const agentById = new Map(AGENTS.map((a) => [a.agentId, a]));
const overlaps = (a: { start: Date; end: Date }, b: { start: Date; end: Date }) =>
  a.start < b.end && b.start < a.end;

describe('critère du lot G : 50 séances, 10 agents', () => {
  const result = run();
  const teamOf = new Map(
    result.proposals.map((p) => [p.target.id, p.assignments.map((a) => a.agentId).sort()]),
  );

  it('le jeu compte 50 séances et 10 agents', () => {
    expect(SESSIONS).toHaveLength(50);
    expect(AGENTS).toHaveLength(10);
  });

  it('toutes les séances possibles sont affectées ; la seule impossible est signalée avec son motif', () => {
    expect(result.proposals).toHaveLength(49);
    expect(result.failures.map((f) => [f.target.id, f.reason])).toEqual([[IMPOSSIBLE[0], 'no_candidate']]);
    expect(result.failures[0]!.rejected.every((c) => c.results.some((r) => !r.passed))).toBe(true);
  });

  it('aucun conflit : trajet compris, entre deux séances d’un même agent (oracle indépendant)', () => {
    const byAgent = new Map<string, AutoTarget[]>();
    for (const [id, team] of teamOf)
      for (const a of team) byAgent.set(a, [...(byAgent.get(a) ?? []), sessionById.get(id)!]);
    for (const [, sessions] of byAgent) {
      const sorted = sessions.sort((x, y) => x.start.getTime() - y.start.getTime());
      for (let i = 1; i < sorted.length; i += 1) {
        const prev = sorted[i - 1]!;
        const next = sorted[i]!;
        const ready = prev.end.getTime() + travelBetween(prev.placeId, next.placeId) * MINUTE;
        expect(ready).toBeLessThanOrEqual(next.start.getTime());
      }
    }
  });

  it('chaque équipe respecte la taille, les compétences, le chef, la zone, les congés et la charge du jour', () => {
    const hoursPerAgentDay = new Map<string, number>();
    for (const proposal of result.proposals) {
      const s = sessionById.get(proposal.target.id)!;
      const members = proposal.assignments.map((a) => agentById.get(a.agentId)!);
      expect(members).toHaveLength(s.expectedTeamSize!);
      const skills = new Set(members.flatMap((m) => m.validatedSkills));
      expect(s.requiredSkills.every((skill) => skills.has(skill))).toBe(true);
      const leads = proposal.assignments.filter((a) => a.isLead);
      expect(leads).toHaveLength(members.length > 1 ? 1 : 0);
      for (const lead of leads) expect(agentById.get(lead.agentId)!.canLead).toBe(true);
      for (const m of members) {
        expect(m.zoneKeys).toContain(s.communeKey);
        expect(m.unavailabilities.some((u) => overlaps(u, s))).toBe(false);
        const key = `${m.agentId}:${s.start.toISOString().slice(0, 10)}`;
        hoursPerAgentDay.set(
          key,
          (hoursPerAgentDay.get(key) ?? 0) + (s.end.getTime() - s.start.getTime()) / 3_600_000,
        );
      }
      expect(proposal.check.agentChecks.flatMap((c) => c.overridesUsed)).toEqual([]);
    }
    for (const hours of hoursPerAgentDay.values()) expect(hours).toBeLessThanOrEqual(8);
  });

  it('même équipe d’une séance à l’autre quand elle est libre (oracle : équipe de la première séance)', () => {
    let checked = 0;
    for (const program of PROGRAMS) {
      const ids = DAYS.map((day) => `${program.programId}-${day}`).filter((id) => teamOf.has(id));
      const reference = teamOf.get(ids[0]!)!;
      for (const id of ids.slice(1)) {
        const s = sessionById.get(id)!;
        const free = reference.every((a) => !agentById.get(a)!.unavailabilities.some((u) => overlaps(u, s)));
        if (!free) continue;
        expect([id, teamOf.get(id)]).toEqual([id, reference]);
        checked += 1;
      }
    }
    // 49 séances affectées, moins la première de chaque programme, moins celles où un membre est absent.
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  it('un membre absent est remplacé ce jour-là seulement, puis l’équipe habituelle revient', () => {
    expect(teamOf.get('p2-2026-11-24')).toEqual(['a02', 'a03']);
    expect(teamOf.get('p2-2026-11-25')).toContain('a02');
    expect(teamOf.get('p2-2026-11-25')).not.toContain('a03');
    expect(teamOf.get('p2-2026-11-26')).toEqual(['a02', 'a03']);
  });

  it('déterministe : mêmes entrées dans un autre ordre, même résultat', () => {
    expect(run([...SESSIONS].reverse(), [...AGENTS].reverse())).toEqual(result);
  });
});

describe('performance', () => {
  it('50 séances et 10 agents en moins d’une seconde', () => {
    // Un passage à blanc, puis le meilleur de trois : la mesure porte sur le calcul, pas sur la
    // compilation à la volée ni sur la charge des autres suites lancées en même temps.
    run();
    const durations = Array.from({ length: 3 }, () => {
      const started = process.hrtime.bigint();
      run();
      return Number(process.hrtime.bigint() - started) / 1e6;
    });
    expect(Math.min(...durations)).toBeLessThan(1000);
  });
});
