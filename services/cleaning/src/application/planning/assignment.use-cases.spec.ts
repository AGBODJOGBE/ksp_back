import { type AppError } from '@ksp/platform';
import {
  agentRecord,
  asStaff,
  InMemoryPlanning,
  NOW,
  planningDeps,
  sessionTarget,
  STAFF,
} from '../testing/planning-fakes';
import { ScheduleOverlapError } from './planning.ports';
import {
  CheckAssignmentUseCase,
  CreateAssignmentsUseCase,
  RemoveAssignmentUseCase,
  UpdateAssignmentUseCase,
} from './assignment.use-cases';

const KEY = 'cle-affectation-0001';
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

function setup() {
  const planning = new InMemoryPlanning();
  planning.addAgent(agentRecord('a1'));
  planning.addAgent(agentRecord('a2', { skills: [] }));
  planning.addAgent(agentRecord('a3', { employmentKind: 'independent' }));
  planning.addTarget(sessionTarget('s1'));
  planning.addTarget(
    sessionTarget('s2', {
      rank: 2,
      placeId: 'place-b',
      start: new Date('2026-11-23T10:10:00Z'),
      end: new Date('2026-11-23T11:00:00Z'),
    }),
  );
  planning.addTarget(
    sessionTarget('s3', {
      rank: 3,
      start: new Date('2026-11-24T08:00:00Z'),
      end: new Date('2026-11-24T10:00:00Z'),
    }),
  );
  const { deps, travelCalls } = planningDeps(planning, {
    'place-a': { 'place-b': 20 },
    'place-b': { 'place-a': 20 },
  });
  return { planning, deps, travelCalls };
}

const create = (deps: ReturnType<typeof setup>['deps'], input: Record<string, unknown>) =>
  asStaff(() =>
    new CreateAssignmentsUseCase(deps).execute({
      idempotencyKey: KEY,
      targets: [{ kind: 'session', id: 's1' }],
      agentIds: ['a1'],
      overrides: [],
      ...input,
    }),
  );

describe('CreateAssignments (UC-NT-37, 9.4, 9.5)', () => {
  it('agent actif, compétent et libre : affectation confirmée, séance planifiée, événement et trace', async () => {
    const { planning, deps, travelCalls } = setup();
    const batch = await create(deps, {});
    expect(batch.assignments).toEqual([
      expect.objectContaining({
        agentId: 'a1',
        status: 'confirmed',
        isLead: false,
        createdBy: STAFF,
        source: 'manual',
      }),
    ]);
    expect(batch.checks).toEqual([expect.objectContaining({ agentId: 'a1', passed: true })]);
    expect(planning.state.targets.get('session:s1')!.status).toBe('assigned');
    expect(planning.events.map((e) => e.type)).toEqual(['cleaning.session.assigned']);
    expect(planning.events[0]!.payload).toMatchObject({
      sessionId: 's1',
      agentIds: ['a1'],
      batchId: null,
      teamIncomplete: false,
    });
    expect(planning.audit.map((a) => a.action)).toEqual(['assignment.created']);
    expect(planning.locks).toEqual([['a1']]);
    expect(travelCalls).toEqual([['place-a']]);
  });

  it('critère du lot D : un agent sans la compétence est refusé, rien n’est écrit', async () => {
    const { planning, deps } = setup();
    const error = await failure(create(deps, { agentIds: ['a2'] }));
    expect(error).toMatchObject({ code: 'CLEANING_SKILL_MISSING', kind: 'FAILED_PRECONDITION' });
    const checks = (error as AppError).details.checks as {
      results: { check: string; missingSkills: string[] }[];
    }[];
    expect(checks[0]!.results.find((r) => r.check === 'skills')!.missingSkills).toEqual(['interior']);
    expect(planning.state.assignments.size).toBe(0);
    expect(planning.events).toEqual([]);
  });

  it('indépendant : en attente de sa réponse, sous 12 h au plus tard au début', async () => {
    const { deps } = setup();
    const batch = await create(deps, { agentIds: ['a3'] });
    expect(batch.assignments[0]).toMatchObject({
      status: 'pending_confirmation',
      respondBefore: new Date(NOW.getTime() + 12 * 3_600_000).toISOString(),
    });
  });

  it('trajet compté depuis l’affectation précédente : conflit si la séance suivante commence trop tôt', async () => {
    const { planning, deps } = setup();
    await create(deps, {});
    const error = await failure(
      create(deps, { idempotencyKey: 'cle-affectation-0002', targets: [{ kind: 'session', id: 's2' }] }),
    );
    expect(error).toMatchObject({ code: 'CLEANING_SCHEDULE_CONFLICT', kind: 'CONFLICT' });
    expect(planning.state.assignments.size).toBe(1);
  });

  it('contrainte d’exclusion de la base (autre superviseur) : CLEANING_SCHEDULE_CONFLICT', async () => {
    const { planning, deps } = setup();
    planning.transaction = async () => {
      throw new ScheduleOverlapError();
    };
    expect(await failure(create(deps, {}))).toMatchObject({ code: 'CLEANING_SCHEDULE_CONFLICT' });
  });

  it('rejouée avec la même clé : même réponse, rien de plus ; autre contenu : clé refusée', async () => {
    const { planning, deps } = setup();
    const first = await create(deps, {});
    expect(await create(deps, {})).toEqual(first);
    expect(planning.events).toHaveLength(1);
    expect(await failure(create(deps, { agentIds: ['a3'] }))).toMatchObject({
      code: 'CLEANING_IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('lot de séances d’un programme : un récapitulatif, les événements unitaires portent le lot', async () => {
    const { planning, deps } = setup();
    const batch = await create(deps, {
      targets: [
        { kind: 'session', id: 's3' },
        { kind: 'session', id: 's1' },
      ],
    });
    expect(batch.batchId).not.toBeNull();
    expect(planning.events.map((e) => e.type)).toEqual([
      'cleaning.session.assigned',
      'cleaning.session.assigned',
      'cleaning.sessions.batch_assigned',
    ]);
    expect(planning.events[2]!.payload).toMatchObject({
      sessionIds: ['s1', 's3'],
      count: 2,
      batchId: batch.batchId,
    });
  });

  it('skipFailing : les cibles en échec sont écartées et rendues', async () => {
    const { planning, deps } = setup();
    planning.addTarget(
      sessionTarget('s4', {
        rank: 4,
        requiredSkills: ['windows'],
        start: new Date('2026-11-25T08:00:00Z'),
        end: new Date('2026-11-25T10:00:00Z'),
      }),
    );
    const batch = await create(deps, {
      targets: [
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's4' },
      ],
      skipFailing: true,
    });
    expect(batch.assignments.map((a) => a.target.id)).toEqual(['s1']);
    expect(batch.skipped).toEqual([
      expect.objectContaining({ agentId: 'a1', target: { kind: 'session', id: 's4' } }),
    ]);
  });

  it('équipe : ses membres actifs et compétents, les autres signalés ; chef de l’équipe', async () => {
    const { planning, deps } = setup();
    planning.addTarget(
      sessionTarget('s5', {
        rank: 5,
        expectedTeamSize: 2,
        start: new Date('2026-11-26T08:00:00Z'),
        end: new Date('2026-11-26T10:00:00Z'),
      }),
    );
    planning.addAgent(agentRecord('a4', { status: 'suspended' }));
    planning.addTeam({
      id: 't1',
      name: 'Équipe',
      leadAgentId: 'a1',
      active: true,
      createdAt: NOW,
      memberIds: ['a1', 'a3', 'a4'],
    });
    const batch = await create(deps, {
      targets: [{ kind: 'session', id: 's5' }],
      agentIds: [],
      teamId: 't1',
    });
    expect(batch.assignments.map((a) => [a.agentId, a.isLead])).toEqual([
      ['a1', true],
      ['a3', false],
    ]);
    expect(batch.checks.map((c) => [c.agentId, c.passed])).toEqual([
      ['a1', true],
      ['a3', true],
      ['a4', false],
    ]);
  });

  it('cible, agent ou équipe inconnus ; appel sans connexion', async () => {
    const { deps } = setup();
    expect(await failure(create(deps, { targets: [{ kind: 'session', id: 'nope' }] }))).toMatchObject({
      code: 'CLEANING_SESSION_NOT_FOUND',
    });
    expect(await failure(create(deps, { targets: [{ kind: 'visit', id: 'nope' }] }))).toMatchObject({
      code: 'CLEANING_VISIT_NOT_FOUND',
    });
    expect(await failure(create(deps, { agentIds: ['zz'] }))).toMatchObject({
      code: 'CLEANING_AGENT_NOT_FOUND',
    });
    expect(await failure(create(deps, { agentIds: [], teamId: 'tt' }))).toMatchObject({
      code: 'CLEANING_TEAM_NOT_FOUND',
    });
    expect(await failure(create(deps, { targets: [{ kind: 'room', id: 's1' }] }))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
    });
    expect(await failure(create(deps, { idempotencyKey: '' }))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
    });
    expect(
      await failure(
        new CreateAssignmentsUseCase(deps).execute({
          idempotencyKey: KEY,
          targets: [],
          agentIds: [],
          overrides: [],
        }),
      ),
    ).toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});

describe('CheckAssignment (9.6, contrôles en direct)', () => {
  it('rend les contrôles sans rien écrire', async () => {
    const { planning, deps } = setup();
    const report = await asStaff(() =>
      new CheckAssignmentUseCase(deps).execute({
        targets: [{ kind: 'session', id: 's1' }],
        agentIds: ['a2'],
        overrides: [],
      }),
    );
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.results.find((r) => r.check === 'skills')).toMatchObject({
      passed: false,
      missingSkills: ['interior'],
    });
    expect(planning.state.assignments.size).toBe(0);
    expect(planning.locks).toEqual([]);
  });

  it('cible passée : CLEANING_INVALID_TRANSITION (target_in_past)', async () => {
    const { planning, deps } = setup();
    planning.addTarget(
      sessionTarget('old', {
        start: new Date('2026-11-19T08:00:00Z'),
        end: new Date('2026-11-19T10:00:00Z'),
      }),
    );
    expect(
      await failure(
        asStaff(() =>
          new CheckAssignmentUseCase(deps).execute({
            targets: [{ kind: 'session', id: 'old' }],
            agentIds: ['a1'],
            overrides: [],
          }),
        ),
      ),
    ).toMatchObject({ code: 'CLEANING_INVALID_TRANSITION', details: { reason: 'target_in_past' } });
  });
});

describe('RemoveAssignment (UC-NT-37, partie 9.5)', () => {
  it('motif obligatoire ; retrait tracé, séance de nouveau à affecter, agents prévenus', async () => {
    const { planning, deps } = setup();
    const batch = await create(deps, {});
    const id = batch.assignments[0]!.id;
    const remove = (input: Record<string, unknown>) =>
      asStaff(() =>
        new RemoveAssignmentUseCase(deps).execute({
          assignmentId: id,
          idempotencyKey: 'cle-retrait-0001',
          reason: 'Client',
          ...input,
        }),
      );
    expect(await failure(remove({ reason: ' ' }))).toMatchObject({ code: 'CLEANING_REASON_REQUIRED' });
    await remove({});
    expect(planning.storedAssignment(id)).toMatchObject({
      status: 'removed',
      removedBy: STAFF,
      removalReason: 'Client',
    });
    expect(planning.state.targets.get('session:s1')!.status).toBe('to_assign');
    expect(planning.events.at(-1)).toMatchObject({
      type: 'cleaning.session.unassigned',
      payload: { agentIds: ['a1'], cause: 'manual' },
    });
    expect(planning.audit.at(-1)).toMatchObject({ action: 'assignment.removed', entityId: id });
    await remove({});
    expect(await failure(remove({ idempotencyKey: 'cle-retrait-0002' }))).toMatchObject({
      code: 'CLEANING_INVALID_TRANSITION',
      details: { from: 'removed', to: 'removed' },
    });
    expect(
      await failure(remove({ assignmentId: 'inconnue', idempotencyKey: 'cle-retrait-0003' })),
    ).toMatchObject({
      code: 'CLEANING_ASSIGNMENT_NOT_FOUND',
    });
  });
});

describe('UpdateAssignment (UC-NT-37, R-EQ-03)', () => {
  it('remplacer un agent : mêmes contrôles ; l’ancien est retiré, le nouveau affecté', async () => {
    const { planning, deps } = setup();
    const id = (await create(deps, {})).assignments[0]!.id;
    const update = (input: Record<string, unknown>) =>
      asStaff(() =>
        new UpdateAssignmentUseCase(deps).execute({ assignmentId: id, reason: 'Échange', ...input }),
      );
    expect(await failure(update({ replaceWithAgentId: 'a2' }))).toMatchObject({
      code: 'CLEANING_SKILL_MISSING',
    });
    const batch = await update({ replaceWithAgentId: 'a3' });
    expect(batch.assignments).toEqual([
      expect.objectContaining({ agentId: 'a3', status: 'pending_confirmation' }),
    ]);
    expect(planning.storedAssignment(id)!.status).toBe('removed');
    expect(planning.audit.at(-1)).toMatchObject({ action: 'assignment.replaced' });
  });

  it('changer le chef d’équipe : l’ancien chef ne l’est plus', async () => {
    const { planning, deps } = setup();
    planning.addTarget(
      sessionTarget('s5', {
        rank: 5,
        expectedTeamSize: 2,
        start: new Date('2026-11-26T08:00:00Z'),
        end: new Date('2026-11-26T10:00:00Z'),
      }),
    );
    const batch = await create(deps, {
      targets: [{ kind: 'session', id: 's5' }],
      agentIds: ['a1', 'a3'],
      leadAgentId: 'a1',
    });
    const other = batch.assignments.find((a) => a.agentId === 'a3')!.id;
    await asStaff(() =>
      new UpdateAssignmentUseCase(deps).execute({ assignmentId: other, isLead: true, reason: 'Ancienneté' }),
    );
    expect([...planning.state.assignments.values()].map((a) => [a.agentId, a.isLead])).toEqual([
      ['a1', false],
      ['a3', true],
    ]);
    expect(planning.audit.at(-1)).toMatchObject({ action: 'assignment.lead_changed' });
  });
});
