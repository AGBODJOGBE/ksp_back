import { travelFromMatrix } from './agenda';
import { agendaEntriesFor, planAssignments, type AssignmentRequest } from './assignment-batch';
import { type PlanningAgent, type PlanningContext, type PlanningTarget } from './assignment-check';

const at = (iso: string) => new Date(iso);
const h = (hours: number) => hours * 60;

const CONTEXT: PlanningContext = {
  now: at('2026-11-20T08:00:00+01:00'),
  travel: travelFromMatrix({ 'place-a': { 'place-b': 30 }, 'place-b': { 'place-a': 30 } }),
  defaultTravelMinutes: 30,
  assignmentResponseHours: 12,
};

function agent(agentId: string, extra: Partial<PlanningAgent> = {}): PlanningAgent {
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
    ...extra,
  };
}

function session(
  id: string,
  placeId: string,
  start: string,
  end: string,
  extra: Partial<PlanningTarget> = {},
): PlanningTarget {
  return {
    target: { kind: 'session', id },
    status: 'to_assign',
    placeId,
    communeKey: 'cotonou',
    start: at(start),
    end: at(end),
    requiredSkills: ['interior'],
    expectedTeamSize: 1,
    assignedAgents: [],
    ...extra,
  };
}

function request(
  targets: PlanningTarget[],
  agents: PlanningAgent[],
  extra: Partial<AssignmentRequest> = {},
): AssignmentRequest {
  return { targets, agents, team: null, leadAgentId: null, overrides: [], skipFailing: false, ...extra };
}

const codes = (outcome: ReturnType<typeof planAssignments>) => outcome.errors.map((error) => error.code);

/** Écrit les affectations retenues dans l'agenda de l'agent, comme le ferait le dépôt sous verrou. */
function afterWrite(
  agentBefore: PlanningAgent,
  outcome: ReturnType<typeof planAssignments>,
  targets: PlanningTarget[],
) {
  const entries = outcome.retained.flatMap((check) =>
    agendaEntriesFor(
      check,
      targets.find((t) => t.target.id === check.target.id)!,
    ).filter((e) => e.agentId === agentBefore.agentId),
  );
  return { ...agentBefore, agenda: [...agentBefore.agenda, ...entries.map((e) => e.entry)] };
}

describe('critère du lot D : deux superviseurs, un même agent, deux séances qui se chevauchent', () => {
  const first = session('s1', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T11:00:00+01:00');
  const firstOutcome = planAssignments(request([first], [agent('x')]), CONTEXT);
  // Le second superviseur obtient le verrou après l'écriture du premier : il relit l'agenda.
  const x = afterWrite(agent('x'), firstOutcome, [first]);

  it('le premier superviseur affecte l’agent', () => {
    expect(firstOutcome.ok).toBe(true);
    expect(firstOutcome.retained.map((c) => c.target.id)).toEqual(['s1']);
  });

  it('le second est refusé sur une séance qui chevauche (CLEANING_SCHEDULE_CONFLICT)', () => {
    const second = session('s2', 'place-a', '2026-11-23T10:00:00+01:00', '2026-11-23T12:00:00+01:00');
    const outcome = planAssignments(request([second], [x]), CONTEXT);
    expect(outcome.ok).toBe(false);
    expect(codes(outcome)).toEqual(['CLEANING_SCHEDULE_CONFLICT']);
    expect(outcome.retained).toEqual([]);
  });

  it('borne : fin de la première = début de la seconde au même lieu, accepté', () => {
    const second = session('s2', 'place-a', '2026-11-23T11:00:00+01:00', '2026-11-23T12:00:00+01:00');
    expect(planAssignments(request([second], [x]), CONTEXT).ok).toBe(true);
  });

  it('borne : trajet juste suffisant vers un autre lieu accepté, une minute de moins refusée', () => {
    const fits = session('s2', 'place-b', '2026-11-23T11:30:00+01:00', '2026-11-23T12:30:00+01:00');
    const short = session('s3', 'place-b', '2026-11-23T11:29:00+01:00', '2026-11-23T12:30:00+01:00');
    expect(planAssignments(request([fits], [x]), CONTEXT).ok).toBe(true);
    expect(codes(planAssignments(request([short], [x]), CONTEXT))).toEqual(['CLEANING_SCHEDULE_CONFLICT']);
  });

  it('fuseau Africa/Porto-Novo : 10 h 29 UTC est 11 h 29 à Porto-Novo, refusé ; 10 h 30 UTC accepté', () => {
    const short = session('s2', 'place-b', '2026-11-23T10:29:00Z', '2026-11-23T11:30:00Z');
    const fits = session('s3', 'place-b', '2026-11-23T10:30:00Z', '2026-11-23T11:30:00Z');
    expect(codes(planAssignments(request([short], [x]), CONTEXT))).toEqual(['CLEANING_SCHEDULE_CONFLICT']);
    expect(planAssignments(request([fits], [x]), CONTEXT).ok).toBe(true);
  });

  it('les entrées écrites portent le trajet et la période occupée, comme assignments_no_overlap', () => {
    const second = session('s2', 'place-b', '2026-11-23T11:30:00+01:00', '2026-11-23T12:30:00+01:00');
    const outcome = planAssignments(request([second], [x]), CONTEXT);
    expect(agendaEntriesFor(outcome.retained[0]!, second)).toEqual([
      {
        agentId: 'x',
        isLead: false,
        occupiedFrom: at('2026-11-23T11:00:00+01:00'),
        entry: expect.objectContaining({ placeId: 'place-b', travelMinutes: 30, status: 'confirmed' }),
      },
    ]);
  });
});

describe('critère du lot D : un agent sans la compétence est refusé', () => {
  it('compétence exigée absente : CLEANING_SKILL_MISSING, rien n’est retenu', () => {
    const pool = session('s1', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T11:00:00+01:00', {
      requiredSkills: ['pool'],
    });
    const outcome = planAssignments(request([pool], [agent('x')]), CONTEXT);
    expect(outcome.ok).toBe(false);
    expect(codes(outcome)).toEqual(['CLEANING_SKILL_MISSING']);
    expect(outcome.errors[0]!.details.target).toEqual({ kind: 'session', id: 's1' });
  });

  it('même agent avec la compétence validée : accepté', () => {
    const pool = session('s1', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T11:00:00+01:00', {
      requiredSkills: ['pool'],
    });
    expect(planAssignments(request([pool], [agent('x', { validatedSkills: ['pool'] })]), CONTEXT).ok).toBe(
      true,
    );
  });
});

describe('affectation en lot (R-PL-11)', () => {
  const morning = session('s1', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T11:00:00+01:00');
  const overlapping = session('s2', 'place-b', '2026-11-23T11:15:00+01:00', '2026-11-23T12:00:00+01:00');
  const later = session('s3', 'place-a', '2026-11-24T09:00:00+01:00', '2026-11-24T11:00:00+01:00');

  it('cibles contrôlées dans l’ordre chronologique, chacune occupant l’agenda pour les suivantes : tout ou rien', () => {
    const outcome = planAssignments(request([later, overlapping, morning], [agent('x')]), CONTEXT);
    expect(outcome.ok).toBe(false);
    expect(outcome.checks.map((c) => [c.target.id, c.passed])).toEqual([
      ['s1', true],
      ['s2', false],
      ['s3', true],
    ]);
    expect(codes(outcome)).toEqual(['CLEANING_SCHEDULE_CONFLICT']);
    expect(outcome.retained).toEqual([]);
    expect(outcome.skipped).toEqual([]);
  });

  it('écarter les cibles en échec (skipFailing) : les autres sont retenues', () => {
    const outcome = planAssignments(
      request([later, overlapping, morning], [agent('x')], { skipFailing: true }),
      CONTEXT,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.retained.map((c) => c.target.id)).toEqual(['s1', 's3']);
    expect(outcome.skipped.map((c) => c.target.id)).toEqual(['s2']);
  });

  it('skipFailing sans aucune cible retenue : refusé', () => {
    const outcome = planAssignments(
      request([overlapping], [agent('x', { status: 'suspended' })], { skipFailing: true }),
      CONTEXT,
    );
    expect(outcome.ok).toBe(false);
    expect(codes(outcome)).toEqual(['CLEANING_AGENT_NOT_ACTIVE']);
  });

  it('la charge du jour s’accumule entre les cibles du lot', () => {
    const a = session('s1', 'place-a', '2026-11-23T06:00:00+01:00', '2026-11-23T11:00:00+01:00');
    const b = session('s2', 'place-a', '2026-11-23T12:00:00+01:00', '2026-11-23T15:01:00+01:00');
    expect(codes(planAssignments(request([a, b], [agent('x')]), CONTEXT))).toEqual([
      'CLEANING_AGENT_OVERLOADED',
    ]);
  });

  it('deux cibles à la même heure de début : ordre stable par type puis identifiant', () => {
    const v = {
      ...session('a', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T10:00:00+01:00'),
      target: { kind: 'visit' as const, id: 'a' },
      status: 'scheduled',
      expectedTeamSize: null,
    };
    const s = session('a', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T10:00:00+01:00');
    const outcome = planAssignments(request([v, s], [agent('x')], { skipFailing: true }), CONTEXT);
    expect(outcome.checks.map((c) => `${c.target.kind}:${c.passed}`)).toEqual([
      'session:true',
      'visit:false',
    ]);
  });
});

describe('contrôles de la demande', () => {
  const target = session('s1', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T11:00:00+01:00');

  it('aucun agent ni équipe : au moins un agent effectif exigé', () => {
    expect(planAssignments(request([target], []), CONTEXT).errors).toEqual([
      { code: 'CLEANING_VALIDATION_FAILED', details: { field: 'agentIds', reason: 'required' } },
    ]);
  });

  it('aucune cible : refusé', () => {
    expect(planAssignments(request([], [agent('x')]), CONTEXT).errors).toEqual([
      { code: 'CLEANING_VALIDATION_FAILED', details: { field: 'targets', reason: 'required' } },
    ]);
  });

  it('contournement sans motif : CLEANING_REASON_REQUIRED, avec les autres motifs', () => {
    const outcome = planAssignments(
      request([target], [agent('x', { zoneKeys: ['porto-novo'] })], {
        overrides: [{ check: 'zone', reason: ' ' }],
      }),
      CONTEXT,
    );
    expect(outcome.errors[0]).toEqual({
      code: 'CLEANING_REASON_REQUIRED',
      details: { field: 'overrides[0].reason' },
    });
    expect(codes(outcome)).toEqual(['CLEANING_REASON_REQUIRED', 'CLEANING_AGENT_OUT_OF_ZONE']);
  });

  it('équipe désactivée : CLEANING_TEAM_INACTIVE', () => {
    const outcome = planAssignments(
      request([target], [agent('x')], { team: { teamId: 't1', active: false, leadAgentId: 'x' } }),
      CONTEXT,
    );
    expect(codes(outcome)).toEqual(['CLEANING_TEAM_INACTIVE']);
  });

  it('équipe active : ses membres disponibles sont affectés, le chef de l’équipe marqué', () => {
    const pair = session('s1', 'place-a', '2026-11-23T09:00:00+01:00', '2026-11-23T11:00:00+01:00', {
      expectedTeamSize: 2,
    });
    const outcome = planAssignments(
      request([pair], [agent('x'), agent('y')], { team: { teamId: 't1', active: true, leadAgentId: 'y' } }),
      CONTEXT,
    );
    expect(outcome.ok).toBe(true);
    expect(agendaEntriesFor(outcome.retained[0]!, pair).map((e) => [e.agentId, e.isLead])).toEqual([
      ['x', false],
      ['y', true],
    ]);
  });
});
