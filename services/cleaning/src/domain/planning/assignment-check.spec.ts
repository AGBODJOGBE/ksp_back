import { validatedSkillCodes } from '../agents/agent';
import { type AgendaEntry, travelFromMatrix } from './agenda';
import {
  checkTarget,
  type CheckOverride,
  type PlanningAgent,
  type PlanningContext,
  type PlanningTarget,
} from './assignment-check';

const at = (iso: string) => new Date(iso);
const h = (hours: number) => hours * 60;

const CONTEXT: PlanningContext = {
  now: at('2026-11-20T08:00:00+01:00'),
  travel: travelFromMatrix({ 'place-a': { 'place-b': 30 }, 'place-b': { 'place-a': 30 } }),
  defaultTravelMinutes: 30,
  assignmentResponseHours: 12,
};

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: h(6), endMinute: h(20) }));

function agent(agentId: string, extra: Partial<PlanningAgent> = {}): PlanningAgent {
  return {
    agentId,
    status: 'active',
    employmentKind: 'employee',
    validatedSkills: ['interior'],
    zoneKeys: ['cotonou'],
    weekly: EVERY_DAY,
    extras: [],
    unavailabilities: [],
    maxHoursPerDay: 8,
    maxHoursPerWeek: 48,
    agenda: [],
    ...extra,
  };
}

/** Séance du lundi 23 novembre 2026, 9 h – 11 h à Porto-Novo, à Cotonou. */
function session(extra: Partial<PlanningTarget> = {}): PlanningTarget {
  return {
    target: { kind: 'session', id: 'session-1' },
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

function entry(id: string, placeId: string, start: string, end: string): AgendaEntry {
  return {
    assignmentId: id,
    target: { kind: 'session', id: `other-${id}` },
    placeId,
    start: at(start),
    end: at(end),
    travelMinutes: 0,
    status: 'confirmed',
    respondBefore: null,
  };
}

function check(
  target: PlanningTarget,
  agents: PlanningAgent[],
  options: {
    mode?: 'agents' | 'team';
    teamLeadId?: string | null;
    leadAgentId?: string | null;
    overrides?: CheckOverride[];
  } = {},
) {
  return checkTarget({
    target,
    agents,
    mode: options.mode ?? 'agents',
    teamLeadId: options.teamLeadId ?? null,
    leadAgentId: options.leadAgentId ?? null,
    overrides: options.overrides ?? [],
    context: CONTEXT,
  });
}

const codes = (result: ReturnType<typeof checkTarget>) => result.errors.map((error) => error.code);

describe('contrôle d’une affectation : cas nominal (9.4)', () => {
  it('agent actif, compétent, dans sa zone, disponible, libre : accepté, salarié confirmé d’office', () => {
    const result = check(session(), [agent('x')]);
    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.agentIds).toEqual(['x']);
    expect(result.agentChecks[0]).toEqual(
      expect.objectContaining({
        agentId: 'x',
        passed: true,
        travelMinutes: 0,
        occupied: { start: at('2026-11-23T09:00:00+01:00'), end: at('2026-11-23T11:00:00+01:00') },
        overridesUsed: [],
        status: 'confirmed',
        respondBefore: null,
      }),
    );
    expect(result.agentChecks[0]!.results.map((r) => [r.check, r.passed])).toEqual([
      ['active', true],
      ['skills', true],
      ['zone', true],
      ['availability', true],
      ['unavailability', true],
      ['conflict', true],
      ['load', true],
      ['team_size', true],
    ]);
  });

  it('indépendant : en attente de sa réponse sous le délai réglé (R-PL-08)', () => {
    const result = check(session(), [agent('x', { employmentKind: 'independent' })]);
    expect(result.agentChecks[0]).toEqual(
      expect.objectContaining({
        status: 'pending_confirmation',
        respondBefore: at('2026-11-20T20:00:00+01:00'),
      }),
    );
  });
});

describe('contrôle d’une affectation : tous les motifs de refus, avec les codes du contrat', () => {
  const busy = entry('b1', 'place-b', '2026-11-23T08:00:00+01:00', '2026-11-23T09:00:00+01:00');
  const worst = agent('x', {
    status: 'suspended',
    validatedSkills: ['garden'],
    zoneKeys: ['porto-novo'],
    weekly: [{ weekday: 1, startMinute: h(10), endMinute: h(18) }],
    unavailabilities: [
      {
        id: 'u1',
        reason: 'leave',
        start: at('2026-11-23T10:00:00+01:00'),
        end: at('2026-11-24T00:00:00+01:00'),
      },
    ],
    maxHoursPerDay: 2,
    agenda: [busy],
  });

  it('chaque contrôle en échec donne son code, dans l’ordre du contrat', () => {
    const result = check(session({ expectedTeamSize: 2 }), [worst]);
    expect(result.passed).toBe(false);
    expect(codes(result)).toEqual([
      'CLEANING_AGENT_NOT_ACTIVE',
      'CLEANING_SKILL_MISSING',
      'CLEANING_AGENT_OUT_OF_ZONE',
      'CLEANING_AGENT_UNAVAILABLE',
      'CLEANING_AGENT_ON_LEAVE',
      'CLEANING_SCHEDULE_CONFLICT',
      'CLEANING_AGENT_OVERLOADED',
      'CLEANING_TEAM_SIZE_MISMATCH',
    ]);
    const results = result.agentChecks[0]!.results;
    expect(results.find((r) => r.check === 'skills')!.missingSkills).toEqual(['interior']);
    expect(results.find((r) => r.check === 'unavailability')!.unavailabilities.map((u) => u.id)).toEqual([
      'u1',
    ]);
    expect(results.find((r) => r.check === 'conflict')!.conflicts).toEqual([
      expect.objectContaining({ assignmentId: 'b1', travelMinutes: 30 }),
    ]);
    expect(results.find((r) => r.check === 'load')!.loadExcesses).toEqual([
      { scope: 'day', from: '2026-11-23', plannedMinutes: 180, maximumMinutes: 120 },
    ]);
    expect(result.errors.find((e) => e.code === 'CLEANING_TEAM_SIZE_MISMATCH')!.details).toEqual(
      expect.objectContaining({ expected: 2 }),
    );
    expect(result.errors.find((e) => e.code === 'CLEANING_SKILL_MISSING')!.details.checks).toEqual([
      result.agentChecks[0],
    ]);
  });

  it('contrôles contournables forcés avec motif : il ne reste que les non contournables', () => {
    const overrides: CheckOverride[] = [
      { check: 'zone', reason: 'Client fidèle' },
      { check: 'availability', reason: 'Accord de l’agent' },
      { check: 'load', reason: 'Semaine chargée' },
      { check: 'team_size', reason: 'Renfort impossible' },
    ];
    const result = check(session({ expectedTeamSize: 2 }), [worst], { overrides });
    expect(codes(result)).toEqual([
      'CLEANING_AGENT_NOT_ACTIVE',
      'CLEANING_SKILL_MISSING',
      'CLEANING_AGENT_ON_LEAVE',
      'CLEANING_SCHEDULE_CONFLICT',
    ]);
    const zone = result.agentChecks[0]!.results.find((r) => r.check === 'zone')!;
    expect(zone).toEqual(expect.objectContaining({ passed: false, overridable: true, overridden: true }));
  });

  it('un congé n’est jamais contourné, même avec motif (R-DS-02, RV-69)', () => {
    const onLeave = agent('x', {
      unavailabilities: [
        {
          id: 'u1',
          reason: 'leave',
          start: at('2026-11-23T00:00:00+01:00'),
          end: at('2026-11-24T00:00:00+01:00'),
        },
      ],
    });
    const result = check(session(), [onLeave], { overrides: [{ check: 'availability', reason: 'Urgent' }] });
    expect(codes(result)).toEqual(['CLEANING_AGENT_ON_LEAVE']);
    expect(result.agentChecks[0]!.results.find((r) => r.check === 'unavailability')).toEqual(
      expect.objectContaining({ overridable: false, overridden: false }),
    );
  });

  it('indisponibilité : sa fin à l’heure du départ (trajet compris) passe ; une minute de plus est refusée', () => {
    const before = entry('b0', 'place-b', '2026-11-23T07:00:00+01:00', '2026-11-23T08:30:00+01:00');
    const leave = (end: string) => [
      { id: 'u1', reason: 'sickness' as const, start: at('2026-11-23T00:00:00+01:00'), end: at(end) },
    ];
    const ok = check(session(), [
      agent('x', { agenda: [before], unavailabilities: leave('2026-11-23T08:30:00+01:00') }),
    ]);
    const ko = check(session(), [
      agent('x', { agenda: [before], unavailabilities: leave('2026-11-23T08:31:00+01:00') }),
    ]);
    expect(codes(ok)).toEqual([]);
    expect(codes(ko)).toEqual(['CLEANING_AGENT_ON_LEAVE']);
  });

  it('un contournement accepté sur un contrôle qui passe n’est pas compté', () => {
    const result = check(session(), [agent('x')], { overrides: [{ check: 'zone', reason: 'Inutile' }] });
    expect(result.passed).toBe(true);
    expect(result.agentChecks[0]!.overridesUsed).toEqual([]);
  });
});

describe('compétences : l’équipe réunie couvre les types de la séance (R-CA-09, R-AG-01)', () => {
  it('critère du lot D : un agent sans la compétence est refusé', () => {
    const result = check(session({ requiredSkills: ['pool'] }), [agent('x')]);
    expect(codes(result)).toEqual(['CLEANING_SKILL_MISSING']);
  });

  it('une compétence déclarée mais non validée ne compte pas', () => {
    const skills = validatedSkillCodes([
      { code: 'interior', status: 'validated' },
      { code: 'pool', status: 'declared' },
    ]);
    const result = check(session({ requiredSkills: ['pool'] }), [
      agent('x', { validatedSkills: [...skills] }),
    ]);
    expect(codes(result)).toEqual(['CLEANING_SKILL_MISSING']);
  });

  it('deux agents qui se complètent : acceptés', () => {
    const result = check(
      session({ requiredSkills: ['interior', 'pool'], expectedTeamSize: 2 }),
      [agent('x'), agent('y', { validatedSkills: ['pool'] })],
      { leadAgentId: 'x' },
    );
    expect(result.passed).toBe(true);
    expect(result.leadAgentId).toBe('x');
  });

  it('les compétences des agents déjà affectés comptent', () => {
    const result = check(
      session({
        requiredSkills: ['interior', 'pool'],
        expectedTeamSize: 2,
        assignedAgents: [{ agentId: 'w', validatedSkills: ['pool'], isLead: true }],
      }),
      [agent('x')],
    );
    expect(result.passed).toBe(true);
    expect(result.leadAgentId).toBeNull();
  });

  it('séance sans compétence exigée : toujours couverte', () => {
    expect(check(session({ requiredSkills: [] }), [agent('x', { validatedSkills: [] })]).passed).toBe(true);
  });
});

describe('taille d’équipe (9.4)', () => {
  it('plus d’agents que prévu : écart signalé, contournable', () => {
    const result = check(session({ expectedTeamSize: 1 }), [agent('x'), agent('y')], { leadAgentId: 'x' });
    expect(codes(result)).toEqual(['CLEANING_TEAM_SIZE_MISMATCH']);
    const forced = check(session({ expectedTeamSize: 1 }), [agent('x'), agent('y')], {
      leadAgentId: 'x',
      overrides: [{ check: 'team_size', reason: 'Gros chantier' }],
    });
    expect(forced.passed).toBe(true);
    expect(forced.warnings).toEqual([]);
  });

  it('moins d’agents que prévu, forcé : accepté avec l’alerte team_size_short', () => {
    const result = check(session({ expectedTeamSize: 3 }), [agent('x')], {
      overrides: [{ check: 'team_size', reason: 'Renfort demain' }],
    });
    expect(result.passed).toBe(true);
    expect(result.warnings).toEqual(['team_size_short']);
  });

  it('visite : pas de taille d’équipe prévue', () => {
    const visit = session({
      target: { kind: 'visit', id: 'visit-1' },
      status: 'scheduled',
      expectedTeamSize: null,
    });
    expect(check(visit, [agent('x'), agent('y')], { leadAgentId: 'x' }).passed).toBe(true);
  });
});

describe('chef d’équipe (R-EQ-03)', () => {
  const pair = session({ expectedTeamSize: 2 });

  it('plus d’un agent sans chef : refusé (leadAgentId obligatoire)', () => {
    const result = check(pair, [agent('x'), agent('y')]);
    expect(result.errors).toEqual([
      { code: 'CLEANING_VALIDATION_FAILED', details: { field: 'leadAgentId', reason: 'required' } },
    ]);
  });

  it('chef qui n’est pas parmi les agents : refusé de même', () => {
    expect(codes(check(pair, [agent('x'), agent('y')], { leadAgentId: 'z' }))).toEqual([
      'CLEANING_VALIDATION_FAILED',
    ]);
  });

  it('un agent seul n’a pas besoin de chef', () => {
    expect(check(session(), [agent('x')]).leadAgentId).toBeNull();
  });

  it('chef déjà en place sur la cible : un second chef est refusé', () => {
    const target = session({
      expectedTeamSize: 2,
      assignedAgents: [{ agentId: 'w', validatedSkills: [], isLead: true }],
    });
    expect(check(target, [agent('x')]).passed).toBe(true);
    expect(check(target, [agent('x')], { leadAgentId: 'x' }).errors).toEqual([
      { code: 'CLEANING_VALIDATION_FAILED', details: { field: 'leadAgentId', reason: 'duplicate' } },
    ]);
  });
});

describe('affecter une équipe : membres actifs et disponibles, les autres signalés (R-EQ-02)', () => {
  const leave = [
    {
      id: 'u1',
      reason: 'leave' as const,
      start: at('2026-11-23T00:00:00+01:00'),
      end: at('2026-11-24T00:00:00+01:00'),
    },
  ];
  const members = [
    agent('lead'),
    agent('m1'),
    agent('off', { status: 'suspended' }),
    agent('away', { unavailabilities: leave }),
  ];

  it('les membres retenus sont contrôlés, les autres sont signalés avec leurs contrôles', () => {
    const result = check(session({ expectedTeamSize: 2 }), members, { mode: 'team', teamLeadId: 'lead' });
    expect(result.passed).toBe(true);
    expect(result.agentIds).toEqual(['lead', 'm1']);
    expect(result.leadAgentId).toBe('lead');
    expect(result.signaled.map((c) => c.agentId)).toEqual(['off', 'away']);
  });

  it('chef de l’équipe indisponible : alerte team_lead_missing, sans refus', () => {
    const result = check(
      session({ expectedTeamSize: 2 }),
      [agent('lead', { unavailabilities: leave }), agent('m1'), agent('m2')],
      {
        mode: 'team',
        teamLeadId: 'lead',
      },
    );
    expect(result.passed).toBe(true);
    expect(result.leadAgentId).toBeNull();
    expect(result.warnings).toEqual(['team_lead_missing']);
  });

  it('aucun membre actif et disponible : au moins un agent effectif exigé (R-PL-11)', () => {
    const result = check(session(), [agent('off', { status: 'suspended' })], {
      mode: 'team',
      teamLeadId: 'off',
    });
    expect(result.errors).toEqual([
      { code: 'CLEANING_VALIDATION_FAILED', details: { field: 'agentIds', reason: 'required' } },
    ]);
  });

  it('un membre déjà affecté à la cible n’est ni repris ni signalé', () => {
    const target = session({
      expectedTeamSize: 2,
      assignedAgents: [{ agentId: 'lead', validatedSkills: ['interior'], isLead: true }],
    });
    const result = check(target, [agent('lead'), agent('m1')], { mode: 'team', teamLeadId: 'lead' });
    expect(result.agentIds).toEqual(['m1']);
    expect(result.signaled).toEqual([]);
    expect(result.passed).toBe(true);
  });
});

describe('cible affectable (R-PL-10, 15.2)', () => {
  it('début passé ou égal à maintenant : refusé (target_in_past) ; une milliseconde après : accepté', () => {
    const past = check(session({ start: CONTEXT.now, end: at('2026-11-20T10:00:00+01:00') }), [agent('x')]);
    expect(past.errors).toContainEqual({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'to_assign', to: 'assigned', reason: 'target_in_past' },
    });
    const soon = check(
      session({ start: at('2026-11-20T08:00:00.001+01:00'), end: at('2026-11-20T10:00:00+01:00') }),
      [agent('x', { weekly: [{ weekday: 5, startMinute: h(8), endMinute: h(10) }] })],
    );
    expect(soon.errors).toEqual([]);
  });

  it('séance d’un programme suspendu : CLEANING_PROGRAM_SUSPENDED', () => {
    expect(codes(check(session({ status: 'suspended' }), [agent('x')]))).toEqual([
      'CLEANING_PROGRAM_SUSPENDED',
    ]);
  });

  it('séance terminée ou annulée, visite non planifiée : transition interdite', () => {
    expect(check(session({ status: 'completed' }), [agent('x')]).errors).toEqual([
      { code: 'CLEANING_INVALID_TRANSITION', details: { from: 'completed', to: 'assigned' } },
    ]);
    const visit = session({
      target: { kind: 'visit', id: 'visit-1' },
      status: 'cancelled',
      expectedTeamSize: null,
    });
    expect(check(visit, [agent('x')]).errors).toEqual([
      { code: 'CLEANING_INVALID_TRANSITION', details: { from: 'cancelled', to: 'scheduled' } },
    ]);
  });

  it('séance déjà planifiée : on peut y ajouter un agent', () => {
    expect(check(session({ status: 'assigned', expectedTeamSize: null }), [agent('x')]).passed).toBe(true);
  });

  it('agent déjà affecté à la cible : refusé (duplicate)', () => {
    const target = session({
      assignedAgents: [{ agentId: 'x', validatedSkills: ['interior'], isLead: false }],
    });
    expect(check(target, [agent('x')]).errors).toContainEqual({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'agentIds', reason: 'duplicate' },
    });
  });
});
