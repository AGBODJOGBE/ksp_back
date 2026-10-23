import { type AppError } from '@ksp/platform';
import { type Intervention, type Mission } from '../../domain/mission';
import { newPaymentState } from '../../domain/payment';
import { RecordPaymentUseCase, ScheduleInterventionUseCase } from '../missions/admin-missions.use-cases';
import { DeactivateZoneUseCase, ListZonesUseCase, SaveZoneUseCase } from '../catalog/zones.use-cases';
import {
  AGENT_ID,
  asAdmin,
  asSupervisor,
  CUSTOMER_ID,
  homeCleaning,
  ORGANIZATION_ID,
  OTHER_AGENT_ID,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import {
  EvaluateStandingUseCase,
  HandleInvoiceEventUseCase,
  WatchIndividualPaymentsUseCase,
} from './standing.use-cases';

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';
const THIRD_AGENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0004';
const uuid = (n: number) => `0192f1c4-7a2b-7c3d-8e4f-${String(n).padStart(12, '0')}`;
// Horloge des doublures : 2026-10-23T08:00:00Z.
const LATER = '2026-11-12T08:00:00.000Z';

function passage(id: string, overrides: Partial<Intervention> = {}): Intervention {
  return {
    id,
    status: 'planned',
    scheduledStart: new Date(LATER),
    durationMinutes: 120,
    agentIds: [AGENT_ID],
    checklist: [],
    incidentNote: null,
    beforePhotoFileIds: [],
    afterPhotoFileIds: [],
    startedAt: null,
    completedAt: null,
    cancellationCause: null,
    cancelledAt: null,
    ...overrides,
  };
}

function mission(overrides: Partial<Mission> = {}): Mission {
  const now = new Date('2026-10-01T08:00:00Z');
  return {
    id: MISSION_ID,
    requestId: uuid(2000),
    quoteId: uuid(3000),
    customerId: CUSTOMER_ID,
    organizationId: ORGANIZATION_ID,
    status: 'scheduled',
    serviceCode: 'home_cleaning',
    commune: 'Cotonou',
    address: 'Lot 12',
    chosenSlot: { start: now, end: now },
    recurrence: { period: 'week', visitsPerPeriod: 1, durationMonths: 3 },
    plannedInterventions: 13,
    interventions: [passage(uuid(1)), passage(uuid(2), { scheduledStart: new Date('2026-11-19T08:00:00Z') })],
    payment: newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 130_000, 30),
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

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

describe('impayés, suspension et reprise (CDC Nettoyage, partie 10)', () => {
  let world: TestWorld;
  let handle: HandleInvoiceEventUseCase;
  let eventNumber = 0;

  const invoiceEvent = (invoice: number, status: 'overdue' | 'paid', eventId = uuid(9000 + ++eventNumber)) =>
    handle.execute({
      eventId,
      eventType: `billing.invoice.${status}`,
      invoiceId: uuid(5000 + invoice),
      contractId: MISSION_ID,
      source: 'cleaning',
      status,
    });
  const stored = () => world.missions.missions.get(MISSION_ID)!;
  const eventTypes = () => world.recorder.events.map((event) => event.type);

  beforeEach(() => {
    world = testWorld();
    world.catalog.services.set('home_cleaning', homeCleaning());
    for (const [agentId, displayName] of [
      [AGENT_ID, 'Awa'],
      [OTHER_AGENT_ID, 'Koffi'],
      [THIRD_AGENT_ID, 'Sena'],
    ] as const) {
      world.agents.agents.set(agentId, { agentId, displayName, active: true, unavailabilities: [] });
    }
    world.missions.missions.set(MISSION_ID, mission());
    handle = new HandleInvoiceEventUseCase(world, new EvaluateStandingUseCase(world));
  });

  it('1 facture impayée : avertissement unique, sans suspension', async () => {
    expect(await invoiceEvent(1, 'overdue')).toBe('warned');
    expect(eventTypes()).toEqual(['cleaning.contract.suspension_warning']);
    expect(world.recorder.events[0]!.payload).toEqual({
      missionId: MISSION_ID,
      customerId: CUSTOMER_ID,
      organizationId: ORGANIZATION_ID,
      unpaidCount: 1,
      suspensionThreshold: 2,
    });
    // Même événement livré deux fois : aucun nouvel effet.
    expect(await invoiceEvent(1, 'overdue', uuid(9001))).toBe('none');
    expect(eventTypes()).toHaveLength(1);
    expect(stored().suspension).toBeNull();
  });

  it('2 factures impayées : passages à venir annulés, agents libérés, planification refusée', async () => {
    await invoiceEvent(1, 'overdue');
    expect(await invoiceEvent(2, 'overdue')).toBe('suspended');
    const suspended = world.recorder.events.find((event) => event.type === 'cleaning.contract.suspended');
    expect(suspended?.payload).toMatchObject({
      cause: 'unpaid_invoices',
      unpaidCount: 2,
      threshold: 2,
      cancelledInterventionIds: [uuid(1), uuid(2)],
      releasedAgentIds: [AGENT_ID],
    });
    expect(stored().interventions.every((i) => i.status === 'cancelled')).toBe(true);
    expect(stored().status).toBe('to_schedule');
    expect(
      await code(
        asSupervisor(() =>
          new ScheduleInterventionUseCase(world).execute({
            missionId: MISSION_ID,
            scheduledStart: LATER,
            durationMinutes: 60,
            agentIds: [AGENT_ID],
            teamId: '',
          }),
        ),
      ),
    ).toBe('CLEANING_CONTRACT_SUSPENDED');
  });

  it('règlement sous le seuil : déblocage et reprogrammation avec les agents libres', async () => {
    await invoiceEvent(1, 'overdue');
    await invoiceEvent(2, 'overdue');
    // Pendant la suspension, l'agent d'origine a été pris ailleurs sur le premier créneau.
    world.missions.unavailabilities.push({
      agentId: AGENT_ID,
      slot: { start: new Date(LATER), end: new Date('2026-11-12T12:00:00Z') },
    });
    expect(await invoiceEvent(1, 'paid')).toBe('resumed');

    const resumed = stored();
    expect(resumed.suspension).toBeNull();
    const planned = resumed.interventions.filter((i) => i.status === 'planned');
    expect(planned.map((i) => [i.scheduledStart.toISOString(), i.agentIds])).toEqual([
      [LATER, [OTHER_AGENT_ID]],
      ['2026-11-19T08:00:00.000Z', [AGENT_ID]],
    ]);
    const events = world.recorder.events;
    expect(events.find((e) => e.type === 'cleaning.contract.resumed')?.payload).toMatchObject({
      unpaidCount: 1,
      rescheduledCount: 2,
      failedCount: 0,
    });
    expect(events.filter((e) => e.type === 'cleaning.mission.scheduled')).toHaveLength(2);
    expect(eventTypes()).not.toContain('cleaning.rescheduling.failed');
  });

  it('reprogrammation impossible faute d’agents : événement pour une replanification manuelle', async () => {
    await invoiceEvent(1, 'overdue');
    await invoiceEvent(2, 'overdue');
    for (const agent of world.agents.agents.values()) agent.active = agent.agentId === AGENT_ID;
    world.missions.unavailabilities.push({
      agentId: AGENT_ID,
      slot: { start: new Date(LATER), end: new Date('2026-11-12T12:00:00Z') },
    });
    expect(await invoiceEvent(2, 'paid')).toBe('resumed');
    expect(world.recorder.events.find((e) => e.type === 'cleaning.rescheduling.failed')?.payload).toEqual({
      missionId: MISSION_ID,
      customerId: CUSTOMER_ID,
      organizationId: ORGANIZATION_ID,
      interventionIds: [uuid(1)],
      failedCount: 1,
    });
  });

  it('une facture payée ne redevient pas impayée, quel que soit l’ordre des événements', async () => {
    await invoiceEvent(1, 'paid');
    expect(await invoiceEvent(1, 'overdue')).toBe('none');
    expect(eventTypes()).toEqual([]);
  });

  it('événements d’un autre service ou d’un contrat inconnu ignorés', async () => {
    expect(
      await handle.execute({
        eventId: uuid(9999),
        eventType: 'billing.invoice.overdue',
        invoiceId: uuid(5001),
        contractId: uuid(4242),
        source: 'cleaning',
        status: 'overdue',
      }),
    ).toBe('ignored');
  });

  it('mission d’entreprise : paiement manuel refusé, il passe par la facture', async () => {
    expect(
      await code(
        asSupervisor(() =>
          new RecordPaymentUseCase(world).execute({
            missionId: MISSION_ID,
            amount: 10_000,
            method: 'cash',
            reference: '',
          }),
        ),
      ),
    ).toBe('CLEANING_PAYMENT_VIA_INVOICE');
  });

  it('zones desservies : ajout, réactivation et désactivation par l’admin seulement', async () => {
    const zones = () => asAdmin(() => new ListZonesUseCase(world).execute());
    expect((await zones()).map((zone) => zone.code)).toEqual(['abomey-calavi', 'cotonou', 'porto-novo']);
    const added = await asAdmin(() => new SaveZoneUseCase(world).execute({ commune: 'Sèmè-Podji' }));
    expect(added).toMatchObject({ code: 'seme-podji', commune: 'Sèmè-Podji', active: true });
    const off = await asAdmin(() => new DeactivateZoneUseCase(world).execute({ code: 'seme-podji' }));
    expect(off.active).toBe(false);
    expect(await code(asAdmin(() => new DeactivateZoneUseCase(world).execute({ code: 'parakou' })))).toBe(
      'CLEANING_ZONE_NOT_FOUND',
    );
    expect(await code(asSupervisor(() => new SaveZoneUseCase(world).execute({ commune: 'Ouidah' })))).toBe(
      'AUTH_FORBIDDEN',
    );
    expect(world.recorder.audit.map((entry) => entry.action)).toEqual(['zone.saved', 'zone.deactivated']);
  });

  describe('particulier en récurrent', () => {
    beforeEach(() => {
      world.missions.missions.set(
        MISSION_ID,
        mission({
          organizationId: null,
          interventions: [
            passage(uuid(10), {
              status: 'completed',
              scheduledStart: new Date('2026-10-20T08:00:00Z'),
              completedAt: new Date('2026-10-20T10:00:00Z'),
            }),
            passage(uuid(1)),
          ],
        }),
      );
    });

    it('1 passage impayé après le délai de grâce suspend ; le paiement débloque', async () => {
      const watch = new WatchIndividualPaymentsUseCase(world, new EvaluateStandingUseCase(world));
      expect(await watch.execute()).toEqual({ examined: 1, failed: 0 });
      expect(stored().suspension?.cause).toBe('unpaid_interventions');
      expect(eventTypes()).toEqual(['cleaning.contract.suspended']);

      await asSupervisor(() =>
        new RecordPaymentUseCase(world).execute({
          missionId: MISSION_ID,
          amount: 10_000,
          method: 'cash',
          reference: '',
        }),
      );
      expect(stored().suspension).toBeNull();
      expect(eventTypes()).toContain('cleaning.contract.resumed');
      expect(stored().interventions.filter((i) => i.status === 'planned')).toHaveLength(1);
    });
  });
});
