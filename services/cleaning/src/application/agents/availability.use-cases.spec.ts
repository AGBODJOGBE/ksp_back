import { type AppError } from '@ksp/platform';
import {
  AGENT_USER,
  agentRecord,
  asStaff,
  asUser,
  InMemoryPlanning,
  NOW,
  planningDeps,
  sessionTarget,
  STAFF,
} from '../testing/planning-fakes';
import { AvailabilityUseCases } from './availability.use-cases';

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => error,
  );

/** Agent a1 (compte AGENT_USER), affecté au lundi 23 novembre 9 h – 11 h (Porto-Novo). */
function setup() {
  const planning = new InMemoryPlanning();
  planning.addAgent(agentRecord('a1', { userId: AGENT_USER }));
  planning.addTarget(sessionTarget('s1', { status: 'assigned' }));
  planning.addAssignment({
    id: 'as1',
    target: { kind: 'session', id: 's1' },
    agentId: 'a1',
    isLead: false,
    source: 'manual',
    status: 'confirmed',
    respondBefore: null,
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
  return { planning, use: new AvailabilityUseCases(deps) };
}

const EVERY_DAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((weekday) => ({
  weekday,
  ranges: [{ start: '06:00', end: '20:00' }],
}));

describe('mes disponibilités (UC-NT-20, R-DS-01, R-DS-05)', () => {
  it('lecture : modèle, exceptions, indisponibilités à venir, charge maximale', async () => {
    const { use } = setup();
    const view = await asUser(() => use.getMine());
    expect(view).toMatchObject({ maxHoursPerDay: 8, maxHoursPerWeek: 48, unavailabilities: [] });
    expect(view.weekly).toHaveLength(7);
  });

  it('remplace le modèle ; retirer une plage occupée passe par le superviseur', async () => {
    const { planning, use } = setup();
    const view = await asUser(() =>
      use.setMine({
        weekly: EVERY_DAY.map((d) => ({ ...d, ranges: [{ start: '07:00', end: '19:00' }] })),
        extraAvailabilities: [],
      }),
    );
    expect(view.weekly[0]).toEqual({ weekday: 1, startMinute: 420, endMinute: 1140 });
    const withoutMonday = EVERY_DAY.filter((d) => d.weekday !== 'mon');
    expect(
      await failure(asUser(() => use.setMine({ weekly: withoutMonday, extraAvailabilities: [] }))),
    ).toMatchObject({
      code: 'CLEANING_AVAILABILITY_IN_USE',
      details: { assignments: ['as1'] },
    });
    expect(planning.audit).toEqual([]);
  });
});

describe('disponibilités au back-office (UC-NT-35)', () => {
  it('sans force : refusé ; avec force : affectations touchées retirées, trace', async () => {
    const { planning, use } = setup();
    const withoutMonday = EVERY_DAY.filter((d) => d.weekday !== 'mon');
    const set = (force: boolean) =>
      asStaff(() =>
        use.setFor({
          agentId: 'a1',
          weekly: withoutMonday,
          extraAvailabilities: [],
          maxHoursPerDay: 6,
          force,
        }),
      );
    expect(await failure(set(false))).toMatchObject({ code: 'CLEANING_AVAILABILITY_IN_USE' });
    const view = await set(true);
    expect(view.maxHoursPerDay).toBe(6);
    expect(planning.storedAssignment('as1')).toMatchObject({
      status: 'removed',
      removalReason: 'agent_unavailable',
    });
    expect(planning.events[0]).toMatchObject({
      type: 'cleaning.session.unassigned',
      payload: { cause: 'unavailability' },
    });
    expect(planning.audit.map((a) => a.action)).toEqual(['assignment.removed', 'agent.availability_changed']);
  });
});

describe('indisponibilités (R-DS-02, R-DS-04)', () => {
  const leave = {
    idempotencyKey: 'conge-0001',
    start: '2026-11-23T00:00:00+01:00',
    end: '2026-11-24T00:00:00+01:00',
    kind: 'leave',
  };

  it('qui chevauche une affectation : refusée avec la liste ; seul le superviseur force', async () => {
    const { planning, use } = setup();
    expect(await failure(asUser(() => use.declareMine(leave)))).toMatchObject({
      code: 'CLEANING_UNAVAILABILITY_CONFLICT',
      details: { assignments: ['as1'] },
    });
    const view = await asStaff(() => use.declareFor({ ...leave, agentId: 'a1', force: true }));
    expect(view.unavailabilities).toEqual([
      expect.objectContaining({ reason: 'leave', forced: true, createdBy: STAFF }),
    ]);
    expect(planning.storedAssignment('as1')!.status).toBe('removed');
    expect(planning.audit.map((a) => a.action)).toEqual([
      'assignment.removed',
      'agent.unavailability_declared',
      'agent.unavailability_forced',
    ]);
  });

  it('sans chevauchement : enregistrée ; retirée ensuite ; inconnue : introuvable', async () => {
    const { planning, use } = setup();
    const declared = await asUser(() =>
      use.declareMine({
        ...leave,
        start: '2026-11-25T00:00:00+01:00',
        end: '2026-11-26T00:00:00+01:00',
        note: ' Mariage ',
      }),
    );
    const [unavailability] = declared.unavailabilities;
    expect(unavailability).toMatchObject({ note: 'Mariage', forced: false, createdBy: AGENT_USER });
    expect(await failure(asUser(() => use.declareMine({ ...leave, kind: 'holiday' })))).toMatchObject({
      details: { field: 'kind' },
    });
    expect((await asUser(() => use.removeMine(unavailability!.id))).unavailabilities).toEqual([]);
    expect(await failure(asUser(() => use.removeMine(unavailability!.id)))).toMatchObject({
      code: 'CLEANING_UNAVAILABILITY_NOT_FOUND',
    });
    expect(planning.audit.map((a) => a.action)).toEqual([
      'agent.unavailability_declared',
      'agent.unavailability_removed',
    ]);
  });

  it('compte sans profil d’agent : CLEANING_AGENT_NOT_FOUND', async () => {
    const { use } = setup();
    expect(await failure(asUser(() => use.getMine(), 'other-user'))).toMatchObject({
      code: 'CLEANING_AGENT_NOT_FOUND',
    });
  });
});
