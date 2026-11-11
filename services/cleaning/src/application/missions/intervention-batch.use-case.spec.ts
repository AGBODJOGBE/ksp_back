import { type AppError } from '@ksp/platform';
import { type Mission } from '../../domain/mission';
import { newPaymentState } from '../../domain/payment';
import { slotFrom } from '../../domain/schedule';
import {
  AGENT_ID,
  asAgent,
  asSupervisor,
  CUSTOMER_ID,
  homeCleaning,
  OTHER_AGENT_ID,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import {
  type ScheduleInterventionBatchInput,
  ScheduleInterventionBatchUseCase,
} from './intervention-batch.use-case';

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-0000000b0001';
/** Chaque lundi de novembre 2026 à 09:00 (08:00 UTC) : 2, 9, 16, 23 et 30. */
const MONDAYS = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'];

function mission(overrides: Partial<Mission> = {}): Mission {
  const now = new Date('2026-10-20T08:00:00Z');
  return {
    id: MISSION_ID,
    requestId: '0192f1c4-7a2b-7c3d-8e4f-0000000a0001',
    quoteId: '0192f1c4-7a2b-7c3d-8e4f-0000000c0001',
    customerId: CUSTOMER_ID,
    organizationId: null,
    status: 'to_schedule',
    serviceCode: 'home_cleaning',
    commune: 'Cotonou',
    address: 'Lot 12, Cotonou',
    location: null,
    landmark: null,
    groupId: null,
    placeType: null,
    chosenSlot: slotFrom(new Date('2026-11-02T08:00:00Z'), 120),
    recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 1 },
    schedule: {
      mode: 'weekly',
      dates: [],
      startDate: '2026-11-02',
      endDate: '2026-11-30',
      weekdays: ['mon'],
      everyWeeks: 1,
      monthDays: [],
      weeksOfMonth: [],
      startTime: '09:00',
      excludedDates: [],
      extraDates: [],
    },
    scheduledDates: MONDAYS,
    plannedInterventions: 5,
    interventions: [],
    payment: newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 100_000, 30),
    cancellationReason: null,
    daysPerWeek: 1,
    suspension: null,
    warningLevel: 0,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...overrides,
  };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => ({ code: error.code, details: error.details }),
  );

describe('planification en lot des dates restantes (ADR-052)', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = testWorld();
    world.catalog.services.set('home_cleaning', homeCleaning());
    for (const agentId of [AGENT_ID, OTHER_AGENT_ID]) {
      world.agents.agents.set(agentId, { agentId, displayName: agentId, active: true, unavailabilities: [] });
    }
    world.missions.missions.set(MISSION_ID, mission());
  });

  const batch = (input: Partial<ScheduleInterventionBatchInput> = {}) =>
    asSupervisor(() =>
      new ScheduleInterventionBatchUseCase(world).execute({
        missionId: MISSION_ID,
        idempotencyKey: 'lot-0001',
        dates: [],
        until: '',
        startTime: '',
        durationMinutes: 120,
        agentIds: [AGENT_ID],
        teamId: '',
        skipConflicts: false,
        ...input,
      }),
    );
  const starts = () =>
    world.missions.missions.get(MISSION_ID)!.interventions.map((i) => i.scheduledStart.toISOString());
  const events = (type: string) => world.recorder.events.filter((event) => event.type === type);

  it('toutes les dates restantes à l’heure du plan, un seul événement récapitulatif', async () => {
    const { mission: view, outcome } = await batch();
    expect(outcome).toEqual({
      missionId: MISSION_ID,
      interventionIds: expect.any(Array),
      scheduledDates: MONDAYS,
      skipped: [],
    });
    expect(view.mission.status).toBe('scheduled');
    expect(starts()).toEqual(MONDAYS.map((date) => `${date}T08:00:00.000Z`));
    expect(
      view.mission.interventions.every((i) => i.agentIds[0] === AGENT_ID && i.checklist.length > 0),
    ).toBe(true);
    expect(events('cleaning.mission.scheduled')).toHaveLength(0);
    expect(events('cleaning.interventions.batch_scheduled')).toEqual([
      {
        type: 'cleaning.interventions.batch_scheduled',
        payload: expect.objectContaining({
          missionId: MISSION_ID,
          customerId: CUSTOMER_ID,
          count: 5,
          firstStart: '2026-11-02T08:00:00.000Z',
          lastStart: '2026-11-30T08:00:00.000Z',
          durationMinutes: 120,
          agentIds: [AGENT_ID],
          skippedDates: [],
          serviceCode: 'home_cleaning',
        }),
      },
    ]);
  });

  it('rejeu avec la même clé : même résultat, rien de plus', async () => {
    const first = await batch();
    const second = await batch();
    expect(second.outcome).toEqual(first.outcome);
    expect(starts()).toHaveLength(5);
    expect(events('cleaning.interventions.batch_scheduled')).toHaveLength(1);
  });

  it('jusqu’à une date, puis le reste ; autre heure ; dates déjà couvertes exclues', async () => {
    await batch({ until: '2026-11-16', startTime: '14:00' });
    expect(starts()).toEqual([
      '2026-11-02T13:00:00.000Z',
      '2026-11-09T13:00:00.000Z',
      '2026-11-16T13:00:00.000Z',
    ]);
    const { outcome } = await batch({ idempotencyKey: 'lot-0002' });
    expect(outcome.scheduledDates).toEqual(['2026-11-23', '2026-11-30']);
    expect(await failure(batch({ idempotencyKey: 'lot-0003' }))).toMatchObject({
      code: 'CLEANING_NO_INTERVENTION_LEFT',
    });
  });

  it('sous-ensemble de dates ; date hors des dates restantes refusée', async () => {
    const { outcome } = await batch({ dates: ['2026-11-30', '2026-11-09'] });
    expect(outcome.scheduledDates).toEqual(['2026-11-09', '2026-11-30']);
    expect(await failure(batch({ idempotencyKey: 'lot-0002', dates: ['2026-11-09'] }))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'dates[0]' },
    });
  });

  it('conflit : tout ou rien par défaut, avec les dates et leurs agents ; sinon dates sautées', async () => {
    world.missions.unavailabilities = [
      { agentId: AGENT_ID, slot: slotFrom(new Date('2026-11-09T07:00:00Z'), 240) },
    ];
    const refused = await failure(batch({ agentIds: [AGENT_ID, OTHER_AGENT_ID] }));
    expect(refused).toEqual({
      code: 'CLEANING_TEAM_UNAVAILABLE',
      details: { agentIds: [AGENT_ID], conflicts: [{ date: '2026-11-09', agentIds: [AGENT_ID] }] },
    });
    expect(starts()).toEqual([]);
    expect(world.recorder.events).toHaveLength(0);

    const { outcome } = await batch({ agentIds: [AGENT_ID, OTHER_AGENT_ID], skipConflicts: true });
    expect(outcome.scheduledDates).toEqual(['2026-11-02', '2026-11-16', '2026-11-23', '2026-11-30']);
    expect(outcome.skipped).toEqual([{ date: '2026-11-09', agentIds: [AGENT_ID] }]);
    expect(events('cleaning.interventions.batch_scheduled')[0]!.payload).toMatchObject({
      count: 4,
      skippedDates: ['2026-11-09'],
    });
  });

  it('plafond par appel, clé obligatoire, mission sans plan, suspendue, rôle', async () => {
    world.schedules.maxBatch = 2;
    expect(await failure(batch())).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'dates' },
    });
    world.schedules.maxBatch = 400;
    expect(await failure(batch({ idempotencyKey: '' }))).toMatchObject({
      details: { field: 'idempotencyKey' },
    });
    world.missions.missions.set(MISSION_ID, mission({ schedule: null, scheduledDates: [] }));
    expect(await failure(batch())).toMatchObject({ details: { field: 'missionId' } });
    world.missions.missions.set(
      MISSION_ID,
      mission({ suspension: { causes: ['unpaid_interventions'], since: new Date(), unpaidCount: 1 } }),
    );
    expect(await failure(batch())).toMatchObject({ code: 'CLEANING_CONTRACT_SUSPENDED' });
    world.missions.missions.set(MISSION_ID, mission());
    const asField = await asAgent(() =>
      new ScheduleInterventionBatchUseCase(world)
        .execute({
          missionId: MISSION_ID,
          idempotencyKey: 'lot-0001',
          dates: [],
          until: '',
          startTime: '',
          durationMinutes: 120,
          agentIds: [AGENT_ID],
          teamId: '',
          skipConflicts: false,
        })
        .then(
          () => null,
          (error: AppError) => error.code,
        ),
    );
    expect(asField).toBe('AUTH_FORBIDDEN');
  });
});
