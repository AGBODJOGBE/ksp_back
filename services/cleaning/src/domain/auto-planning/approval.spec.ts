import { type AgendaEntry, travelFromMatrix } from '../planning/agenda';
import { type PlanningAgent, type PlanningContext, type PlanningTarget } from '../planning/assignment-check';
import { type ApprovalTarget, approveProposals, type ProposalRow } from './approval';
import { runAutoPlanning } from './auto-planning';
import { DEFAULT_SCORE_WEIGHTS } from './score';

const at = (iso: string) => new Date(iso);

const CONTEXT: PlanningContext = {
  now: at('2026-11-21T08:00:00+01:00'),
  travel: travelFromMatrix({}),
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
    weekly: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMinute: 360, endMinute: 1320 })),
    extras: [],
    unavailabilities: [],
    maxHoursPerDay: 8,
    maxHoursPerWeek: 48,
    agenda: [],
    ...extra,
  };
}

function session(id: string, extra: Partial<PlanningTarget> = {}): PlanningTarget {
  return {
    target: { kind: 'session', id },
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

/** Proposition en vigueur : une ligne « proposed » et l'entrée qu'elle occupe dans l'agenda de l'agent. */
function proposed(
  target: PlanningTarget,
  agentId: string,
  isLead = false,
  status: ProposalRow['status'] = 'proposed',
) {
  const row: ProposalRow = {
    assignmentId: `as-${target.target.id}-${agentId}`,
    agentId,
    isLead,
    status,
    respondBefore: null,
  };
  const entry: AgendaEntry = {
    assignmentId: row.assignmentId,
    target: target.target,
    placeId: target.placeId,
    start: target.start,
    end: target.end,
    travelMinutes: 0,
    status,
    respondBefore: null,
  };
  return { row, entry };
}

/** Cible vue par le dépôt : ses affectations en vigueur, propositions comprises. */
function withProposals(target: PlanningTarget, rows: ProposalRow[]): ApprovalTarget {
  return {
    target: {
      ...target,
      assignedAgents: rows.map((r) => ({
        agentId: r.agentId,
        validatedSkills: ['interior'],
        isLead: r.isLead,
      })),
    },
    proposals: rows,
  };
}

describe('R-PL-05 : validation des propositions en un clic', () => {
  it('cas nominal : salarié confirmé, indépendant en attente 12 h depuis la validation (R-PL-08)', () => {
    const s1 = session('s1');
    const s2 = session('s2', {
      start: at('2026-11-24T09:00:00+01:00'),
      end: at('2026-11-24T11:00:00+01:00'),
    });
    const p1 = proposed(s1, 'a1');
    const p2 = proposed(s2, 'a2');
    const outcome = approveProposals({
      targets: [withProposals(s2, [p2.row]), withProposals(s1, [p1.row])],
      agents: [
        agent('a1', { agenda: [p1.entry] }),
        agent('a2', { employmentKind: 'independent', agenda: [p2.entry] }),
      ],
      context: CONTEXT,
    });
    expect(outcome.ignored).toEqual([]);
    expect(outcome.approved).toEqual([
      expect.objectContaining({ assignmentId: 'as-s1-a1', status: 'confirmed', respondBefore: null }),
      expect.objectContaining({
        assignmentId: 'as-s2-a2',
        status: 'pending_confirmation',
        respondBefore: at('2026-11-21T20:00:00+01:00'),
      }),
    ]);
  });

  it('équipe de deux avec son chef : les deux validées, le chef gardé', () => {
    const s1 = session('s1', { expectedTeamSize: 2 });
    const lead = proposed(s1, 'a1', true);
    const member = proposed(s1, 'a2');
    const outcome = approveProposals({
      targets: [withProposals(s1, [lead.row, member.row])],
      agents: [agent('a1', { agenda: [lead.entry] }), agent('a2', { agenda: [member.entry] })],
      context: CONTEXT,
    });
    expect(outcome.approved.map((a) => [a.assignmentId, a.isLead])).toEqual([
      ['as-s1-a1', true],
      ['as-s1-a2', false],
    ]);
  });

  it('cas limite : valider une seule proposition d’une équipe ; l’autre reste proposée et compte', () => {
    const s1 = session('s1', { expectedTeamSize: 2 });
    const lead = proposed(s1, 'a1', true);
    const member = proposed(s1, 'a2');
    const target = withProposals(s1, [lead.row, member.row]);
    const outcome = approveProposals({
      targets: [{ ...target, proposals: [member.row] }],
      agents: [agent('a2', { agenda: [member.entry] })],
      context: CONTEXT,
    });
    expect(outcome.approved.map((a) => a.assignmentId)).toEqual(['as-s1-a2']);
  });
});

describe('ApproveProposals : contrôles refaits, proposition devenue impossible signalée et ignorée', () => {
  it('cas limite (RV-01) : agent en congé depuis la proposition : ignorée, CLEANING_AGENT_ON_LEAVE', () => {
    const s1 = session('s1');
    const p1 = proposed(s1, 'a1');
    const leave = {
      id: 'u1',
      reason: 'leave' as const,
      start: at('2026-11-23T00:00:00+01:00'),
      end: at('2026-11-24T00:00:00+01:00'),
    };
    const outcome = approveProposals({
      targets: [withProposals(s1, [p1.row])],
      agents: [agent('a1', { agenda: [p1.entry], unavailabilities: [leave] })],
      context: CONTEXT,
    });
    expect(outcome.approved).toEqual([]);
    expect(outcome.ignored).toMatchObject([
      { target: { id: 's1' }, assignmentIds: ['as-s1-a1'], errors: [{ code: 'CLEANING_AGENT_ON_LEAVE' }] },
    ]);
  });

  it('cas limite (R-PL-10) : début de la séance passé : target_in_past', () => {
    const s1 = session('s1', { start: CONTEXT.now, end: at('2026-11-21T10:00:00+01:00') });
    const p1 = proposed(s1, 'a1');
    const outcome = approveProposals({
      targets: [withProposals(s1, [p1.row])],
      agents: [agent('a1', { agenda: [p1.entry] })],
      context: CONTEXT,
    });
    expect(outcome.ignored[0]!.errors).toContainEqual(
      expect.objectContaining({
        code: 'CLEANING_INVALID_TRANSITION',
        details: expect.objectContaining({ reason: 'target_in_past' }),
      }),
    );
  });

  it('cas limite : proposition déjà retirée : CLEANING_INVALID_TRANSITION, les autres sont validées', () => {
    const s1 = session('s1', { expectedTeamSize: 2 });
    const removed = proposed(s1, 'a1', false, 'removed');
    const lead = proposed(s1, 'a2', true);
    const member = proposed(s1, 'a3');
    const outcome = approveProposals({
      targets: [
        {
          target: {
            ...s1,
            assignedAgents: [
              { agentId: 'a2', validatedSkills: ['interior'], isLead: true },
              { agentId: 'a3', validatedSkills: ['interior'], isLead: false },
            ],
          },
          proposals: [removed.row, lead.row, member.row],
        },
      ],
      agents: [agent('a2', { agenda: [lead.entry] }), agent('a3', { agenda: [member.entry] })],
      context: CONTEXT,
    });
    expect(outcome.ignored).toEqual([
      {
        target: s1.target,
        assignmentIds: ['as-s1-a1'],
        errors: [{ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'removed', to: 'confirmed' } }],
      },
    ]);
    expect(outcome.approved.map((a) => a.assignmentId)).toEqual(['as-s1-a2', 'as-s1-a3']);
  });

  it('un membre pris ailleurs : toute l’équipe de la séance est ignorée (taille non forcée)', () => {
    const s1 = session('s1', { expectedTeamSize: 2 });
    const lead = proposed(s1, 'a1', true);
    const member = proposed(s1, 'a2');
    const other: AgendaEntry = {
      ...member.entry,
      assignmentId: 'manual',
      target: { kind: 'visit', id: 'v1' },
    };
    const outcome = approveProposals({
      targets: [withProposals(s1, [lead.row, member.row])],
      agents: [agent('a1', { agenda: [lead.entry] }), agent('a2', { agenda: [member.entry, other] })],
      context: CONTEXT,
    });
    expect(outcome.approved).toEqual([]);
    expect(outcome.ignored[0]!.assignmentIds).toEqual(['as-s1-a1', 'as-s1-a2']);
    expect(outcome.ignored[0]!.errors.map((e) => e.code)).toEqual(['CLEANING_SCHEDULE_CONFLICT']);
  });
});

describe('ApproveProposals : cas limites des données relues', () => {
  it('toutes les lignes d’une cible périmées (attente échue comprise) : rien n’est contrôlé', () => {
    const s1 = session('s1');
    const expired = {
      ...proposed(s1, 'a1', false, 'pending_confirmation').row,
      respondBefore: at('2026-11-21T07:00:00+01:00'),
    };
    const outcome = approveProposals({
      targets: [withProposals(s1, [expired])],
      agents: [agent('a1')],
      context: CONTEXT,
    });
    expect(outcome.approved).toEqual([]);
    expect(outcome.ignored).toEqual([
      {
        target: s1.target,
        assignmentIds: ['as-s1-a1'],
        errors: [{ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'expired', to: 'confirmed' } }],
      },
    ]);
  });

  it('agent absent des données relues : aucun agent effectif, proposition ignorée', () => {
    const s1 = session('s1');
    const outcome = approveProposals({
      targets: [withProposals(s1, [proposed(s1, 'a1').row])],
      agents: [],
      context: CONTEXT,
    });
    expect(outcome.ignored[0]!.errors).toContainEqual(
      expect.objectContaining({
        code: 'CLEANING_VALIDATION_FAILED',
        details: { field: 'agentIds', reason: 'required' },
      }),
    );
  });
});

describe('de la proposition à la validation', () => {
  it('un passage en mode proposition, puis la validation de tout : tout est confirmé', () => {
    const targets = ['23', '24'].map((d) => ({
      ...session(`s${d}`, {
        start: at(`2026-11-${d}T09:00:00+01:00`),
        end: at(`2026-11-${d}T11:00:00+01:00`),
      }),
      programId: 'p1',
    }));
    const agents = [{ ...agent('a1'), canLead: true, ratingAverage: null }];
    const run = runAutoPlanning({
      targets,
      agents,
      programHistory: {},
      scope: {
        window: { start: at('2026-11-20T00:00:00Z'), end: at('2026-12-01T00:00:00Z') },
        zoneKey: null,
        programId: null,
      },
      modes: { defaultMode: 'proposal', byZone: {} },
      weights: DEFAULT_SCORE_WEIGHTS,
      context: { ...CONTEXT, now: at('2026-11-20T08:00:00+01:00') },
    });
    const rows = run.proposals.map((p) => {
      const target = targets.find((t) => t.target.id === p.target.id)!;
      return { target, ...proposed(target, p.assignments[0]!.agentId, p.assignments[0]!.isLead) };
    });
    const outcome = approveProposals({
      targets: rows.map((r) => withProposals(r.target, [r.row])),
      agents: [agent('a1', { agenda: rows.map((r) => r.entry) })],
      context: CONTEXT,
    });
    expect(outcome.approved.map((a) => [a.assignmentId, a.status])).toEqual([
      ['as-s23-a1', 'confirmed'],
      ['as-s24-a1', 'confirmed'],
    ]);
  });
});
