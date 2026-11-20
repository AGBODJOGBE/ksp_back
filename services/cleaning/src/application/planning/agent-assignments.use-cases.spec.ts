import { type AppError } from '@ksp/platform';
import {
  AGENT_USER,
  agentRecord,
  asUser,
  InMemoryPlanning,
  NOW,
  planningDeps,
  sessionTarget,
  STAFF,
} from '../testing/planning-fakes';
import { AgentAssignmentUseCases } from './agent-assignments.use-cases';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

/** Indépendant a1 (compte AGENT_USER), en attente de sa réponse sur la séance s1 jusqu'à 19 h UTC. */
function setup(respondBefore = new Date('2026-11-20T19:00:00Z')) {
  const planning = new InMemoryPlanning();
  planning.addAgent(agentRecord('a1', { userId: AGENT_USER, employmentKind: 'independent' }));
  planning.addAgent(agentRecord('a2'));
  planning.addTarget(sessionTarget('s1', { status: 'assigned' }));
  planning.addAssignment({
    id: 'as1',
    target: { kind: 'session', id: 's1' },
    agentId: 'a1',
    isLead: false,
    source: 'manual',
    status: 'pending_confirmation',
    respondBefore,
    overrides: [],
    reason: null,
    createdBy: STAFF,
    createdAt: NOW,
    start: new Date('2026-11-23T08:00:00Z'),
    end: new Date('2026-11-23T10:00:00Z'),
    occupiedFrom: new Date('2026-11-23T08:00:00Z'),
    occupiedUntil: new Date('2026-11-23T10:00:00Z'),
    travelMinutes: 0,
    placeId: 'place-a',
  });
  const { deps } = planningDeps(planning);
  return { planning, use: new AgentAssignmentUseCases(deps) };
}

describe('mon planning (UC-NT-21)', () => {
  it('mes affectations avec le statut de la cible, sans montants', async () => {
    const { use } = setup();
    const page = await asUser(() => use.list({}));
    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'as1',
        status: 'pending_confirmation',
        targetStatus: 'assigned',
        placeTypeName: 'Villa',
      }),
    ]);
    expect(await failure(asUser(() => use.list({ status: 'lost' })))).toMatchObject({
      details: { field: 'status' },
    });
  });
});

describe('réponse de l’indépendant (R-PL-08)', () => {
  it('accepter : confirmée ; rejouée : même réponse', async () => {
    const { planning, use } = setup();
    const accept = () =>
      asUser(() => use.respond({ assignmentId: 'as1', idempotencyKey: 'reponse-0001', answer: 'accept' }));
    expect(await accept()).toMatchObject({ id: 'as1', status: 'confirmed' });
    expect(await accept()).toMatchObject({ status: 'confirmed' });
    expect(planning.storedAssignment('as1')!.status).toBe('confirmed');
  });

  it('refuser : séance de nouveau à affecter, événement agent_declined', async () => {
    const { planning, use } = setup();
    expect(
      await asUser(() =>
        use.respond({ assignmentId: 'as1', idempotencyKey: 'reponse-0002', answer: 'decline' }),
      ),
    ).toMatchObject({
      status: 'declined',
    });
    expect(planning.state.targets.get('session:s1')!.status).toBe('to_assign');
    expect(planning.events[0]).toMatchObject({
      type: 'cleaning.session.unassigned',
      payload: { cause: 'agent_declined', agentIds: ['a1'] },
    });
  });

  it('après l’échéance : expirée, transition interdite ; affectation d’un autre : introuvable', async () => {
    const { planning, use } = setup(new Date('2026-11-20T06:00:00Z'));
    expect(
      await failure(
        asUser(() => use.respond({ assignmentId: 'as1', idempotencyKey: 'reponse-0003', answer: 'accept' })),
      ),
    ).toMatchObject({ code: 'CLEANING_INVALID_TRANSITION', details: { from: 'expired', to: 'confirmed' } });
    planning.state.assignments.get('as1')!.agentId = 'a2';
    expect(
      await failure(
        asUser(() => use.respond({ assignmentId: 'as1', idempotencyKey: 'reponse-0004', answer: 'accept' })),
      ),
    ).toMatchObject({ code: 'CLEANING_ASSIGNMENT_NOT_FOUND' });
  });
});
