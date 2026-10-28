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
import { HandleOrganizationEventUseCase, ReconcileOrganizationUseCase } from './organization.use-cases';
import {
  EvaluateStandingUseCase,
  HandleInvoiceEventUseCase,
  MissionSuspension,
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

  describe('organisation suspendue par KSP (ADR-030)', () => {
    let organizationEvent: HandleOrganizationEventUseCase;
    // Décisions d'identity dans l'ordre chronologique.
    let decisionAt = Date.parse('2026-10-23T07:00:00Z');

    const organization = (suspended: boolean, options: { eventId?: string; occurredAt?: string } = {}) =>
      organizationEvent.execute({
        eventId: options.eventId ?? uuid(8000 + ++eventNumber),
        eventType: suspended ? 'identity.organization.suspended' : 'identity.organization.reactivated',
        organizationId: ORGANIZATION_ID,
        suspended,
        occurredAt: options.occurredAt ?? new Date((decisionAt += 60_000)).toISOString(),
      });
    const count = (type: string) => eventTypes().filter((t) => t === type).length;
    const payloadOf = (type: string) => world.recorder.events.filter((e) => e.type === type).at(-1)?.payload;

    beforeEach(() => {
      const suspension = new MissionSuspension(world);
      const evaluate = new EvaluateStandingUseCase(world, suspension);
      organizationEvent = new HandleOrganizationEventUseCase(
        world,
        new ReconcileOrganizationUseCase(world, suspension, evaluate),
      );
      handle = new HandleInvoiceEventUseCase(world, evaluate);
    });

    it('organisation seule : passages annulés, agents libérés, reprise à la réactivation', async () => {
      expect(await organization(true)).toEqual({ examined: 1, changed: 1 });
      expect(payloadOf('cleaning.contract.suspended')).toMatchObject({
        cause: 'organization_suspended',
        unpaidCount: 0,
        threshold: 2,
        cancelledInterventionIds: [uuid(1), uuid(2)],
        releasedAgentIds: [AGENT_ID],
      });
      expect(stored().suspension?.causes).toEqual(['organization_suspended']);
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
      // Même événement livré deux fois : aucun nouvel effet.
      expect(await organization(true, { eventId: uuid(8000 + eventNumber) })).toEqual({
        examined: 1,
        changed: 0,
      });
      expect(count('cleaning.contract.suspended')).toBe(1);

      expect(await organization(false)).toEqual({ examined: 1, changed: 1 });
      expect(stored().suspension).toBeNull();
      expect(payloadOf('cleaning.contract.resumed')).toMatchObject({
        cause: 'organization_suspended',
        unpaidCount: 0,
        rescheduledCount: 2,
        failedCount: 0,
      });
      expect(stored().interventions.filter((i) => i.status === 'planned')).toHaveLength(2);
    });

    it('impayés puis organisation : le règlement ne reprend pas, la réactivation si', async () => {
      await invoiceEvent(1, 'overdue');
      expect(await invoiceEvent(2, 'overdue')).toBe('suspended');
      expect(await organization(true)).toEqual({ examined: 1, changed: 1 });
      expect(count('cleaning.contract.suspended')).toBe(1);
      expect(stored().suspension).toMatchObject({
        causes: ['unpaid_invoices', 'organization_suspended'],
        unpaidCount: 2,
      });

      expect(await invoiceEvent(1, 'paid')).toBe('cause_lifted');
      expect(stored().suspension?.causes).toEqual(['organization_suspended']);
      expect(count('cleaning.contract.resumed')).toBe(0);

      expect(await organization(false)).toEqual({ examined: 1, changed: 1 });
      expect(stored().suspension).toBeNull();
      expect(payloadOf('cleaning.contract.resumed')).toMatchObject({
        cause: 'organization_suspended',
        unpaidCount: 1,
        rescheduledCount: 2,
      });
      // 1 facture encore impayée, déjà annoncée avant la suspension : pas de nouvel avertissement.
      expect(count('cleaning.contract.suspension_warning')).toBe(1);
    });

    it('organisation puis impayés : la réactivation ne reprend pas, le règlement si', async () => {
      await organization(true);
      // Déjà arrêtée : pas d'avertissement à la première facture impayée.
      expect(await invoiceEvent(1, 'overdue')).toBe('none');
      expect(await invoiceEvent(2, 'overdue')).toBe('cause_added');
      expect(count('cleaning.contract.suspended')).toBe(1);
      expect(stored().suspension?.causes).toEqual(['organization_suspended', 'unpaid_invoices']);

      expect(await organization(false)).toEqual({ examined: 1, changed: 1 });
      expect(stored().suspension?.causes).toEqual(['unpaid_invoices']);
      expect(count('cleaning.contract.resumed')).toBe(0);

      expect(await invoiceEvent(2, 'paid')).toBe('resumed');
      expect(stored().suspension).toBeNull();
      expect(payloadOf('cleaning.contract.resumed')).toMatchObject({
        cause: 'unpaid_invoices',
        unpaidCount: 1,
      });
      expect(stored().interventions.filter((i) => i.status === 'planned')).toHaveLength(2);
    });

    it('impayés seuls : la réactivation d’une organisation jamais suspendue ne change rien', async () => {
      await invoiceEvent(1, 'overdue');
      await invoiceEvent(2, 'overdue');
      expect(await organization(false)).toEqual({ examined: 1, changed: 0 });
      expect(stored().suspension?.causes).toEqual(['unpaid_invoices']);
      expect(await invoiceEvent(2, 'paid')).toBe('resumed');
    });

    it('facture impayée pendant la suspension, sans avertissement : avertie à la reprise', async () => {
      await organization(true);
      expect(await invoiceEvent(1, 'overdue')).toBe('none');
      await organization(false);
      expect(stored().suspension).toBeNull();
      expect(eventTypes().at(-1)).toBe('cleaning.contract.suspension_warning');
      expect(stored().warningLevel).toBe(1);
    });

    it('événements dans le désordre : une décision plus ancienne que la dernière est sans effet', async () => {
      await organization(true, { occurredAt: '2026-10-23T07:30:00Z' });
      expect(await organization(false, { occurredAt: '2026-10-23T07:10:00Z' })).toEqual({
        examined: 1,
        changed: 0,
      });
      expect(stored().suspension?.causes).toEqual(['organization_suspended']);
    });

    it('changements de cause annoncés au client par cleaning.contract.suspension_updated', async () => {
      await organization(true);
      await invoiceEvent(1, 'overdue');
      expect(await invoiceEvent(2, 'overdue')).toBe('cause_added');
      expect(payloadOf('cleaning.contract.suspension_updated')).toEqual({
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        change: 'cause_added',
        cause: 'unpaid_invoices',
        causes: ['organization_suspended', 'unpaid_invoices'],
        unpaidCount: 2,
        updatedAt: '2026-10-23T08:00:00.000Z',
      });
      await organization(false);
      expect(payloadOf('cleaning.contract.suspension_updated')).toMatchObject({
        change: 'cause_lifted',
        cause: 'organization_suspended',
        causes: ['unpaid_invoices'],
        unpaidCount: 2,
      });
      expect(count('cleaning.contract.suspension_updated')).toBe(2);
      expect(count('cleaning.contract.suspended')).toBe(1);
      // Le règlement lève la dernière cause : reprise, pas de changement de cause.
      await invoiceEvent(1, 'paid');
      await invoiceEvent(2, 'paid');
      expect(count('cleaning.contract.suspension_updated')).toBe(2);
      expect(count('cleaning.contract.resumed')).toBe(1);
    });

    it('réactivation avec des impayés au seuil non enregistrés : ils prennent le relais, sans reprise', async () => {
      await organization(true);
      // Factures passées impayées sans réévaluation de la mission (événements absents ou seuil
      // abaissé pendant la suspension).
      for (const invoice of [1, 2]) {
        world.invoices.invoices.set(uuid(5000 + invoice), { missionId: MISSION_ID, status: 'overdue' });
      }
      expect(await organization(false)).toEqual({ examined: 1, changed: 1 });
      expect(stored().suspension).toMatchObject({ causes: ['unpaid_invoices'], unpaidCount: 2 });
      expect(count('cleaning.contract.resumed')).toBe(0);
      expect(count('cleaning.contract.suspended')).toBe(1);
      expect(payloadOf('cleaning.contract.suspension_updated')).toMatchObject({
        change: 'cause_lifted',
        cause: 'organization_suspended',
        causes: ['unpaid_invoices'],
      });
      // Les passages restent annulés jusqu'au règlement.
      expect(stored().interventions.filter((i) => i.status === 'planned')).toHaveLength(0);
      expect(await invoiceEvent(2, 'paid')).toBe('resumed');
    });

    it('réactivation enregistrée pendant l’alignement d’une suspension : l’alignement recommence', async () => {
      const list = world.missions.listActiveForOrganization.bind(world.missions);
      let interleaved = false;
      jest.spyOn(world.missions, 'listActiveForOrganization').mockImplementation(async (organizationId) => {
        const missions = await list(organizationId);
        if (!interleaved) {
          interleaved = true;
          // Réactivation traitée en parallèle : enregistrée, mais ses missions déjà lues.
          await world.organizations.record({
            eventId: uuid(8500),
            consumer: 'cleaning.identity.organization.reactivated',
            organizationId: ORGANIZATION_ID,
            suspended: false,
            at: new Date('2026-10-23T09:00:00Z'),
          });
        }
        return missions;
      });
      expect(await organization(true, { occurredAt: '2026-10-23T08:30:00Z' })).toEqual({
        examined: 1,
        changed: 2,
      });
      expect(stored().suspension).toBeNull();
      expect(eventTypes().filter((type) => type.startsWith('cleaning.contract.'))).toEqual([
        'cleaning.contract.suspended',
        'cleaning.contract.resumed',
      ]);
    });

    it('état qui change sans cesse : CLEANING_CONCURRENT_UPDATE, le message sera retraité', async () => {
      let flip = false;
      jest.spyOn(world.organizations, 'isSuspended').mockImplementation(async () => (flip = !flip));
      const reconcile = new ReconcileOrganizationUseCase(
        world,
        new MissionSuspension(world),
        new EvaluateStandingUseCase(world),
      );
      expect(await code(reconcile.execute(ORGANIZATION_ID))).toBe('CLEANING_CONCURRENT_UPDATE');
    });

    it('missions terminées, d’une autre organisation ou personnelles : intactes', async () => {
      world.missions.missions.set(MISSION_ID, mission({ status: 'completed' }));
      const other = uuid(1001);
      const personal = uuid(1002);
      world.missions.missions.set(other, mission({ id: other, organizationId: uuid(7777) }));
      world.missions.missions.set(personal, mission({ id: personal, organizationId: null }));
      expect(await organization(true)).toEqual({ examined: 0, changed: 0 });
      expect(eventTypes()).toEqual([]);
    });
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
      expect(stored().suspension?.causes).toEqual(['unpaid_interventions']);
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
