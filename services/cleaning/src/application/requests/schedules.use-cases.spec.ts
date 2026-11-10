import { type AppError } from '@ksp/platform';
import { PreviewScheduleUseCase, SimulateUseCase } from '../catalog/catalog.use-cases';
import { ScheduleInterventionUseCase } from '../missions/admin-missions.use-cases';
import { type ScheduleInput } from '../shared/schedules';
import {
  AGENT_ID,
  asCustomer,
  asSupervisor,
  homeCleaning,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import { CompleteVisitUseCase, ScheduleVisitUseCase, SendQuoteUseCase } from './admin-requests.use-cases';
import { AcceptQuoteUseCase, RequestQuoteUseCase } from './customer-requests.use-cases';

/** Horloge des tests : 2026-10-23T08:00Z ; délai minimum de 48 heures. */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => ({ code: error.code, field: error.details?.field }),
  );

const WEEKLY: ScheduleInput = {
  mode: 'weekly',
  startDate: '2026-11-10',
  endDate: '2027-11-11',
  weekdays: ['mon', 'wed', 'sat'],
  startTime: '08:00',
};
const THREE_DATES: ScheduleInput = {
  mode: 'dates',
  dates: ['2026-11-02', '2026-11-16', '2026-11-30'],
  startTime: '09:30',
};
const ANSWERS = {
  answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal' },
  optionSelections: [{ code: 'windows', answers: { window_count: 8 } }],
  frequency: 'once',
};
const PLAN = { option: 'deposit', timing: 'before', method: 'cash' };

describe('plan de passages par dates (ADR-052)', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = testWorld();
    world.catalog.services.set('home_cleaning', homeCleaning());
    world.agents.agents.set(AGENT_ID, {
      agentId: AGENT_ID,
      displayName: 'Awa',
      active: true,
      unavailabilities: [],
    });
  });

  const request = (timing: object, key = 'k-1') =>
    asCustomer(() =>
      new RequestQuoteUseCase(world).execute({
        idempotencyKey: key,
        serviceCode: 'home_cleaning',
        ...ANSWERS,
        commune: 'Abomey-Calavi',
        address: 'Lot 12, Abomey-Calavi',
        preferredSlots: [],
        comment: '',
        requestedTeamSize: 0,
        ...timing,
      }),
    );

  const completeVisit = async (requestId: string) => {
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    const before = world.clock.current;
    world.clock.current = new Date('2026-10-26T11:00:00Z');
    await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({ visitId: visited.visit!.id, report: 'Visite faite.' }),
    );
    world.clock.current = before;
  };

  const sendQuote = (requestId: string, extra: object = {}) =>
    asSupervisor(() =>
      new SendQuoteUseCase(world).execute({
        requestId,
        lines: [],
        proposedSlots: [],
        validityDays: 0,
        teamSize: 0,
        durationMinutes: 180,
        ...extra,
      }),
    );

  describe('aperçu public', () => {
    it('hebdomadaire lundi, mercredi, samedi du 2026-11-10 au 2027-11-11 : 157 dates exactes', async () => {
      const preview = await new PreviewScheduleUseCase(world).execute(WEEKLY);
      expect(preview).toMatchObject({
        count: 157,
        firstDate: '2026-11-11',
        lastDate: '2027-11-10',
        warnings: [],
      });
      expect(preview.dates).toHaveLength(157);
    });

    it('refuse un plan absent, mal formé, trop proche ou trop chargé', async () => {
      const preview = (input: ScheduleInput | null) =>
        failure(new PreviewScheduleUseCase(world).execute(input));
      expect(await preview(null)).toEqual({ code: 'CLEANING_VALIDATION_FAILED', field: 'schedule.mode' });
      expect(await preview({ ...WEEKLY, weekdays: [] })).toEqual({
        code: 'CLEANING_VALIDATION_FAILED',
        field: 'schedule.weekdays',
      });
      // Premier passage le samedi 24 octobre à 08:00 : moins de 48 heures.
      expect(await preview({ ...WEEKLY, startDate: '2026-10-24' })).toMatchObject({
        code: 'CLEANING_LEAD_TIME_TOO_SHORT',
      });
      world.schedules.maxVisits = 100;
      expect(await preview(WEEKLY)).toEqual({ code: 'CLEANING_VALIDATION_FAILED', field: 'schedule' });
      expect(
        await preview({
          mode: 'dates',
          dates: ['2026-11-02'],
          excludedDates: ['2026-11-02'],
          startTime: '08:00',
        }),
      ).toEqual({ code: 'CLEANING_VALIDATION_FAILED', field: 'schedule' });
    });
  });

  it('simulation : montant estimé sur le nombre exact de passages', async () => {
    const result = await new SimulateUseCase(world).execute({
      serviceCode: 'home_cleaning',
      commune: 'Abomey-Calavi',
      ...ANSWERS,
      schedule: THREE_DATES,
    });
    expect(result.calculation.computedPrice).toBe(35_700);
    expect(result.schedule).toEqual({
      preview: expect.objectContaining({ count: 3, firstDate: '2026-11-02', lastDate: '2026-11-30' }),
      total: 107_100,
      estimate: { low: 96_000, high: 123_000 },
    });
    const without = await new SimulateUseCase(world).execute({ serviceCode: 'home_cleaning', ...ANSWERS });
    expect(without.schedule).toBeNull();
  });

  it('demande avec un plan : dates exactes, créneau souhaité déduit, récurrence et jours par semaine dérivés', async () => {
    const created = await request({ schedule: WEEKLY });
    expect(created.schedule).toMatchObject({
      mode: 'weekly',
      weekdays: ['mon', 'wed', 'sat'],
      everyWeeks: 1,
    });
    expect(created.scheduledDates).toHaveLength(157);
    // 08:00 à Porto-Novo = 07:00 UTC ; durée indicative de 2 heures.
    expect(created.preferredSlots).toEqual([
      { start: new Date('2026-11-11T07:00:00Z'), end: new Date('2026-11-11T09:00:00Z') },
    ]);
    expect(created.recurrence).toEqual({ period: 'week', visitsPerPeriod: 3, durationMonths: 12 });
    expect(created.daysPerWeek).toBe(3);
  });

  it('refuse plan et ancienne récurrence ensemble, et une demande sans plan ni créneau', async () => {
    const recurrence = { period: 'week', visitsPerPeriod: 1, durationMonths: 3 };
    expect(await failure(request({ schedule: WEEKLY, recurrence }))).toEqual({
      code: 'CLEANING_VALIDATION_FAILED',
      field: 'recurrence',
    });
    expect(await failure(request({}))).toMatchObject({ code: 'CLEANING_SLOT_INVALID' });
  });

  it('ancienne récurrence : traduite quand elle est exacte, gardée approximative sinon', async () => {
    // Vendredi 30 octobre, 09:00 à Porto-Novo.
    const slot = { start: '2026-10-30T08:00:00Z', end: '2026-10-30T11:00:00Z' };
    const translated = await request({
      preferredSlots: [slot],
      recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 3 },
    });
    expect(translated.schedule).toMatchObject({
      mode: 'weekly',
      startDate: '2026-10-30',
      endDate: '2027-01-29',
      weekdays: ['fri'],
      startTime: '09:00',
    });
    expect(translated.scheduledDates).toHaveLength(14);
    expect(translated.preferredSlots).toEqual([{ start: new Date(slot.start), end: new Date(slot.end) }]);

    const legacy = await request(
      { preferredSlots: [slot], recurrence: { period: 'week', visitsPerPeriod: 2, durationMonths: 3 } },
      'k-2',
    );
    expect(legacy.schedule).toBeNull();
    expect(legacy.scheduledDates).toEqual([]);
    expect(legacy.recurrence).toEqual({ period: 'week', visitsPerPeriod: 2, durationMonths: 3 });
  });

  it('devis : prix × nombre exact de dates, plan ajustable, mission créée avec ses dates', async () => {
    const created = await request({ schedule: THREE_DATES });
    await completeVisit(created.id);
    const sent = await sendQuote(created.id);
    expect(sent.quote).toMatchObject({
      subtotal: 35_700,
      interventionCount: 3,
      total: 107_100,
      scheduledDates: ['2026-11-02', '2026-11-16', '2026-11-30'],
      // Créneau proposé : le premier passage, avec la durée du devis.
      proposedSlots: [{ start: new Date('2026-11-02T08:30:00Z'), end: new Date('2026-11-02T11:30:00Z') }],
      recurrence: { period: 'month', visitsPerPeriod: 3, durationMonths: 1 },
    });

    // Après la visite, la supervision ajoute un passage : le devis est révisé.
    const adjusted = await sendQuote(created.id, {
      schedule: { ...THREE_DATES, extraDates: ['2026-12-14'] },
    });
    expect(adjusted.quote).toMatchObject({ interventionCount: 4, total: 142_800 });

    const { mission } = await asCustomer(() =>
      new AcceptQuoteUseCase(world).execute({
        requestId: created.id,
        idempotencyKey: 'acc-1',
        slotStart: '2026-11-02T08:30:00Z',
        paymentPlan: PLAN,
      }),
    );
    expect(mission.mission).toMatchObject({
      plannedInterventions: 4,
      scheduledDates: ['2026-11-02', '2026-11-16', '2026-11-30', '2026-12-14'],
      schedule: expect.objectContaining({ mode: 'dates', startTime: '09:30' }),
    });
    expect(mission.mission.payment).toMatchObject({ total: 142_800, depositAmount: 42_840 });
    const booking = world.recorder.events.find((event) => event.type === 'cleaning.booking.confirmed');
    expect(booking?.payload).toMatchObject({
      plannedInterventions: 4,
      schedulePeriod: { firstDate: '2026-11-02', lastDate: '2026-12-14' },
    });

    // Planification sans date : la prochaine date du plan encore sans passage, à son heure.
    const schedule = () =>
      asSupervisor(() =>
        new ScheduleInterventionUseCase(world).execute({
          missionId: mission.mission.id,
          scheduledStart: '',
          durationMinutes: 180,
          agentIds: [AGENT_ID],
          teamId: '',
        }),
      );
    await schedule();
    const second = await schedule();
    expect(second.mission.interventions.map((i) => i.scheduledStart.toISOString())).toEqual([
      '2026-11-02T08:30:00.000Z',
      '2026-11-16T08:30:00.000Z',
    ]);
  });

  it('devis sur le plan de la demande : recontrôlé, refusé si le premier passage est trop proche', async () => {
    const created = await request({ schedule: THREE_DATES });
    await completeVisit(created.id);
    world.clock.current = new Date('2026-11-01T08:00:00Z');
    expect(await failure(sendQuote(created.id))).toMatchObject({ code: 'CLEANING_LEAD_TIME_TOO_SHORT' });
    const sent = await sendQuote(created.id, {
      schedule: { ...THREE_DATES, dates: ['2026-11-16', '2026-11-30'] },
    });
    expect(sent.quote).toMatchObject({ interventionCount: 2, total: 71_400 });
  });

  it('devis sans plan ni créneau : refusé ; ancien devis sans plan inchangé', async () => {
    const slot = { start: '2026-10-30T08:00:00Z', end: '2026-10-30T11:00:00Z' };
    const created = await request({ preferredSlots: [slot] });
    await completeVisit(created.id);
    expect(await failure(sendQuote(created.id))).toMatchObject({ code: 'CLEANING_SLOT_INVALID' });
    const sent = await sendQuote(created.id, { proposedSlots: [slot] });
    expect(sent.quote).toMatchObject({ interventionCount: 1, schedule: null, scheduledDates: [] });
  });
});
