import { type AppError } from '@ksp/platform';
import { type Mission } from '../../domain/mission';
import { newPaymentState } from '../../domain/payment';
import {
  GetCatalogUseCase,
  SaveServiceUseCase,
  UpdateSettingsUseCase,
} from '../catalog/admin-catalog.use-cases';
import { HasPendingObligationsUseCase } from '../obligations/has-pending-obligations.use-case';
import {
  CreateTeamUseCase,
  DeclareUnavailabilityUseCase,
  RegisterAgentUseCase,
} from '../teams/admin-teams.use-cases';
import {
  AGENT_ID,
  asAdmin,
  asAgent,
  asCustomer,
  asSupervisor,
  asSuperAdmin,
  CUSTOMER_ID,
  homeCleaning,
  OTHER_AGENT_ID,
  OTHER_CUSTOMER_ID,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import {
  CancelMissionAsSupervisorUseCase,
  CompleteInterventionUseCase,
  GetMissionDetailUseCase,
  ListMissionsUseCase,
  RecordPaymentUseCase,
  ReportIncidentUseCase,
  ResumeInterventionUseCase,
  ScheduleInterventionUseCase,
  StartInterventionUseCase,
  UpdateChecklistUseCase,
} from './admin-missions.use-cases';
import { CancelMyMissionUseCase, GetMyMissionUseCase } from './customer-missions.use-cases';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';

function mission(overrides: Partial<Mission> = {}): Mission {
  const now = new Date('2026-10-23T08:00:00Z');
  return {
    id: MISSION_ID,
    requestId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d2000',
    quoteId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d3000',
    customerId: CUSTOMER_ID,
    organizationId: null,
    status: 'to_schedule',
    serviceCode: 'home_cleaning',
    commune: 'Cotonou',
    address: 'Lot 12',
    chosenSlot: { start: new Date('2026-10-30T08:00:00Z'), end: new Date('2026-10-30T11:00:00Z') },
    recurrence: null,
    plannedInterventions: 1,
    interventions: [],
    payment: newPaymentState({ option: 'deposit', timing: 'before', method: 'cash' }, 50_000, 30),
    cancellationReason: null,
    daysPerWeek: null,
    suspension: null,
    warningLevel: 0,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...overrides,
  };
}

describe('missions et passages (UC-CL-09, 10)', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = testWorld();
    world.catalog.services.set('home_cleaning', homeCleaning());
    for (const [agentId, displayName] of [
      [AGENT_ID, 'Awa'],
      [OTHER_AGENT_ID, 'Koffi'],
    ] as const) {
      world.agents.agents.set(agentId, { agentId, displayName, active: true, unavailabilities: [] });
    }
    world.missions.missions.set(MISSION_ID, mission());
  });

  const schedule = (start: string, agentIds: string[], missionId = MISSION_ID) =>
    asSupervisor(() =>
      new ScheduleInterventionUseCase(world).execute({
        missionId,
        scheduledStart: start,
        durationMinutes: 180,
        agentIds,
        teamId: '',
      }),
    );
  const interventionOf = (index = 0) => world.missions.missions.get(MISSION_ID)!.interventions[index]!.id;

  it('planifie un passage : mission planifiée, liste de contrôle copiée, événement publié', async () => {
    const view = await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    expect(view.mission.status).toBe('scheduled');
    expect(view.agentNames).toEqual({ [AGENT_ID]: 'Awa' });
    expect(view.mission.interventions[0]!.checklist.length).toBeGreaterThan(0);
    expect(world.recorder.events).toEqual([
      expect.objectContaining({
        type: 'cleaning.mission.scheduled',
        payload: expect.objectContaining({ agentIds: [AGENT_ID] }),
      }),
    ]);
  });

  it('refuse un agent déjà pris ou indisponible (CLEANING_TEAM_UNAVAILABLE)', async () => {
    world.missions.missions.set('m2', mission({ id: 'm2', plannedInterventions: 1 }));
    await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    expect(await code(schedule('2026-10-30T10:00:00Z', [AGENT_ID], 'm2'))).toBe('CLEANING_TEAM_UNAVAILABLE');
    world.missions.unavailabilities = [
      {
        agentId: OTHER_AGENT_ID,
        slot: { start: new Date('2026-10-30T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') },
      },
    ];
    expect(await code(schedule('2026-10-30T12:00:00Z', [OTHER_AGENT_ID], 'm2'))).toBe(
      'CLEANING_TEAM_UNAVAILABLE',
    );
    expect(await code(schedule('2026-10-30T12:00:00Z', [AGENT_ID], 'm2'))).toBe('ok');
  });

  it('contrat récurrent : un agent différent à chaque passage, jamais plus que prévu', async () => {
    world.missions.missions.set(MISSION_ID, mission({ plannedInterventions: 2 }));
    await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    const view = await schedule('2026-11-06T08:00:00Z', [OTHER_AGENT_ID]);
    expect(view.mission.interventions.map((i) => i.agentIds)).toEqual([[AGENT_ID], [OTHER_AGENT_ID]]);
    expect(await code(schedule('2026-11-13T08:00:00Z', [AGENT_ID]))).toBe('CLEANING_NO_INTERVENTION_LEFT');
  });

  it('agent : seulement ses missions ; démarrer, cocher, clôturer ; mission terminée', async () => {
    await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    const id = interventionOf();
    const other = <T>(fn: () => T) => asAgent(fn, OTHER_AGENT_ID);
    expect(await code(other(() => new GetMissionDetailUseCase(world).execute(MISSION_ID)))).toBe(
      'CLEANING_MISSION_NOT_FOUND',
    );
    expect(await code(other(() => new StartInterventionUseCase(world).execute(id)))).toBe(
      'CLEANING_INTERVENTION_NOT_FOUND',
    );
    const listed = await other(() =>
      new ListMissionsUseCase(world).execute({ page: { limit: 20, cursor: null }, status: '' }),
    );
    expect(listed.items).toEqual([]);

    world.clock.current = new Date('2026-10-30T07:30:00Z');
    expect((await asAgent(() => new StartInterventionUseCase(world).execute(id))).mission.status).toBe(
      'in_progress',
    );
    expect(await code(asAgent(() => new CompleteInterventionUseCase(world).execute(id)))).toBe(
      'CLEANING_CHECKLIST_INCOMPLETE',
    );
    const codes = world.missions.missions
      .get(MISSION_ID)!
      .interventions[0]!.checklist.map((item) => item.code);
    await asAgent(() => new UpdateChecklistUseCase(world).execute({ interventionId: id, doneCodes: codes }));
    const done = await asAgent(() => new CompleteInterventionUseCase(world).execute(id));
    expect(done.mission.status).toBe('completed');
    expect(world.recorder.events.at(-1)).toMatchObject({
      type: 'cleaning.mission.completed',
      payload: { missionId: MISSION_ID, completedInterventions: 1 },
    });
  });

  it('incident : passage en attente puis reprise ; transition interdite refusée', async () => {
    await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    const id = interventionOf();
    expect(
      await code(
        asAgent(() => new ReportIncidentUseCase(world).execute({ interventionId: id, note: 'Coupure' })),
      ),
    ).toBe('CLEANING_INVALID_TRANSITION');
    world.clock.current = new Date('2026-10-30T07:30:00Z');
    await asAgent(() => new StartInterventionUseCase(world).execute(id));
    const held = await asAgent(() =>
      new ReportIncidentUseCase(world).execute({ interventionId: id, note: 'Coupure d’eau' }),
    );
    expect(held.mission.status).toBe('on_hold');
    expect((await asAgent(() => new ResumeInterventionUseCase(world).execute(id))).mission.status).toBe(
      'in_progress',
    );
  });

  it('paiement manuel : acompte reçu puis payé ; trop-perçu et moyen en ligne refusés', async () => {
    const pay = (amount: number, method = 'cash') =>
      asSupervisor(() =>
        new RecordPaymentUseCase(world).execute({ missionId: MISSION_ID, amount, method, reference: 'R1' }),
      );
    expect(await code(pay(1000, 'mobile_money_online'))).toBe('CLEANING_PAYMENT_INVALID');
    await pay(15_000);
    expect(world.missions.missions.get(MISSION_ID)!.payment.payments).toHaveLength(1);
    expect(await code(pay(40_000))).toBe('CLEANING_PAYMENT_INVALID');
    await pay(35_000, 'mobile_money_offline');
    expect(world.recorder.audit.filter((entry) => entry.action === 'payment.recorded')).toHaveLength(2);
    expect(
      await code(
        asAgent(() =>
          new RecordPaymentUseCase(world).execute({
            missionId: MISSION_ID,
            amount: 1,
            method: 'cash',
            reference: '',
          }),
        ),
      ),
    ).toBe('AUTH_FORBIDDEN');
  });

  it('démarrage refusé avant le jour prévu, à l’heure du Bénin ; permis le jour même (règle réglable)', async () => {
    await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    const id = interventionOf();
    const start = () => asAgent(() => new StartInterventionUseCase(world).execute(id));
    // 29 octobre 22:30 UTC = 29 octobre 23:30 au Bénin : encore la veille.
    world.clock.current = new Date('2026-10-29T22:30:00Z');
    const error = await start().catch((e: AppError) => e);
    expect(error).toMatchObject({
      code: 'CLEANING_INTERVENTION_TOO_EARLY',
      message: 'Ce passage est prévu le 30 octobre 2026 : il ne peut pas être démarré avant ce jour.',
      details: { scheduledDate: '2026-10-30', timeZone: 'Africa/Porto-Novo' },
    });
    // 29 octobre 23:30 UTC = 30 octobre 00:30 au Bénin : le jour prévu, avant l'heure du créneau.
    world.clock.current = new Date('2026-10-29T23:30:00Z');
    expect((await start()).mission.status).toBe('in_progress');
  });

  it('démarrage anticipé permis quand la règle est désactivée par configuration', async () => {
    world.fieldDates.blockEarlyInterventionStart = false;
    await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    world.clock.current = new Date('2026-10-28T08:00:00Z');
    expect(
      (await asAgent(() => new StartInterventionUseCase(world).execute(interventionOf()))).mission.status,
    ).toBe('in_progress');
  });

  it('paiement au-delà du dû : le reste dû figure dans le message et les détails', async () => {
    const pay = (amount: number) =>
      asSupervisor(() =>
        new RecordPaymentUseCase(world).execute({
          missionId: MISSION_ID,
          amount,
          method: 'cash',
          reference: '',
        }),
      );
    await pay(37_500);
    const error = await pay(20_000).catch((e: AppError) => e);
    expect(error).toMatchObject({
      code: 'CLEANING_PAYMENT_INVALID',
      message: 'Ce paiement dépasse le reste dû : 12 500 FCFA.',
      details: { reason: 'exceeds_balance', remainingDue: { amount: 12_500, currency: 'XOF' } },
    });
    await pay(12_500);
    expect(await pay(1).catch((e: AppError) => e)).toMatchObject({
      message: 'Cette mission est déjà entièrement payée : aucun paiement de plus ne peut être enregistré.',
      details: { remainingDue: { amount: 0, currency: 'XOF' } },
    });
  });

  it('paiement manuel idempotent : même clé, un seul paiement ; clé invalide refusée', async () => {
    const pay = (idempotencyKey: string, amount = 15_000) =>
      asSupervisor(() =>
        new RecordPaymentUseCase(world).execute({
          missionId: MISSION_ID,
          amount,
          method: 'cash',
          reference: 'R1',
          idempotencyKey,
        }),
      );
    const first = await pay('paiement-0001');
    const replay = await pay('paiement-0001');
    expect(replay.mission.payment.payments).toHaveLength(1);
    expect(replay.mission.payment.payments).toEqual(first.mission.payment.payments);
    expect(world.missions.missions.get(MISSION_ID)!.payment.payments).toHaveLength(1);
    expect(world.recorder.audit.filter((entry) => entry.action === 'payment.recorded')).toHaveLength(1);
    // Un rejeu est rendu même si le montant renvoyé dépasserait maintenant le reste dû.
    await pay('paiement-0002', 35_000);
    expect((await pay('paiement-0002', 35_000)).mission.payment.payments).toHaveLength(2);
    expect(await code(pay('court'))).toBe('CLEANING_VALIDATION_FAILED');
  });

  it('paiement idempotent : envoi concurrent rejoué après l’écriture de l’autre', async () => {
    const payment = (idempotencyKey: string) =>
      asSupervisor(() =>
        new RecordPaymentUseCase(world).execute({
          missionId: MISSION_ID,
          amount: 15_000,
          method: 'cash',
          reference: '',
          idempotencyKey,
        }),
      );
    // Le premier envoi lit la mission, puis le second s'enregistre avant lui (même version lue).
    const stale = world.missions.missions.get(MISSION_ID)!;
    const findById = world.missions.findById.bind(world.missions);
    let calls = 0;
    world.missions.findById = async (id: string) => {
      calls += 1;
      return calls === 1 ? stale : findById(id);
    };
    await world.missions.save(
      {
        ...stale,
        payment: {
          ...stale.payment,
          payments: [
            {
              id: 'p-concurrent',
              amount: 15_000,
              method: 'cash',
              reference: null,
              recordedBy: 'sup',
              recordedAt: new Date('2026-10-23T08:00:00Z'),
              idempotencyKey: 'paiement-0003',
            },
          ],
        },
      },
      { events: [], audit: [] },
    );
    const view = await payment('paiement-0003');
    expect(view.mission.payment.payments.map((p) => p.id)).toEqual(['p-concurrent']);
    expect(world.missions.missions.get(MISSION_ID)!.payment.payments).toHaveLength(1);
  });

  it('super_admin : voit et pilote les missions comme cleaning_admin', async () => {
    await schedule('2026-10-30T08:00:00Z', [AGENT_ID]);
    const listed = await asSuperAdmin(() =>
      new ListMissionsUseCase(world).execute({ page: { limit: 20, cursor: null }, status: '' }),
    );
    expect(listed.items.map((view) => view.mission.id)).toEqual([MISSION_ID]);
    world.clock.current = new Date('2026-10-30T07:00:00Z');
    expect(
      (await asSuperAdmin(() => new StartInterventionUseCase(world).execute(interventionOf()))).mission
        .status,
    ).toBe('in_progress');
    expect(
      await code(
        asSuperAdmin(
          () => new ListMissionsUseCase(world).execute({ page: { limit: 20, cursor: null }, status: '' }),
          false,
        ),
      ),
    ).toBe('AUTH_MFA_REQUIRED');
  });

  it('annulation par le client : sans frais avant 24 h, refusée après ; 404 pour un autre client', async () => {
    expect(
      await code(asCustomer(() => new GetMyMissionUseCase(world).execute(MISSION_ID), OTHER_CUSTOMER_ID)),
    ).toBe('CLEANING_MISSION_NOT_FOUND');
    world.clock.current = new Date('2026-10-29T09:00:00Z');
    expect(
      await code(
        asCustomer(() => new CancelMyMissionUseCase(world).execute({ missionId: MISSION_ID, reason: '' })),
      ),
    ).toBe('CLEANING_CANCELLATION_TOO_LATE');
    world.clock.current = new Date('2026-10-28T08:00:00Z');
    const view = await asCustomer(() =>
      new CancelMyMissionUseCase(world).execute({ missionId: MISSION_ID, reason: '' }),
    );
    expect(view.mission.status).toBe('cancelled');
    expect(world.recorder.events.at(-1)).toMatchObject({
      type: 'cleaning.request.cancelled',
      payload: { missionId: MISSION_ID },
    });
  });

  it('annulation par la supervision, motif obligatoire', async () => {
    const cancel = (reason: string) =>
      asSupervisor(() =>
        new CancelMissionAsSupervisorUseCase(world).execute({ missionId: MISSION_ID, reason }),
      );
    expect(await code(cancel(''))).toBe('CLEANING_VALIDATION_FAILED');
    expect((await cancel('Client injoignable')).mission.status).toBe('cancelled');
  });

  it('obligations : une mission non terminée bloque la suppression du compte', async () => {
    const obligations = new HasPendingObligationsUseCase(world);
    expect(await obligations.execute({ userId: CUSTOMER_ID })).toEqual([
      expect.objectContaining({ kind: 'open_cleaning_mission', reference: MISSION_ID }),
    ]);
    expect(await obligations.execute({ userId: OTHER_CUSTOMER_ID })).toEqual([]);
  });
});

describe('administration du catalogue et des équipes (UC-CL-11, 12)', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = testWorld();
  });

  const pricing = {
    unitPrice: 250,
    minimumPrice: 25_000,
    options: [{ code: 'windows', label: 'Vitres', price: 10_000 }],
    communeCoefficients: [{ commune: 'Abomey Calavi', coefficientBp: 11_000 }],
    defaultCoefficientBp: 0,
    teamSize: null,
    checklist: [],
  };
  const save = (unitPrice: number | null) =>
    asAdmin(() =>
      new SaveServiceUseCase(world).execute({
        code: 'office_cleaning',
        name: 'Nettoyage de bureaux',
        description: '',
        unit: 'square_meter',
        active: true,
        pricing: { ...pricing, unitPrice },
      }),
    );

  it('chaque modification de grille crée une version datée avec son auteur', async () => {
    const v1 = await save(250);
    const v2 = await save(300);
    expect([v1.pricing.version, v2.pricing.version]).toEqual([1, 2]);
    expect(v2.pricing.communeCoefficients).toEqual({ 'abomey-calavi': 11_000 });
    expect(world.recorder.audit.map((entry) => entry.action)).toEqual(['service.saved', 'service.saved']);
    expect(await code(save(12.5))).toBe('CLEANING_VALIDATION_FAILED');
    expect(await code(asSupervisor(() => new GetCatalogUseCase(world).execute()))).toBe('AUTH_FORBIDDEN');
  });

  it('réglages : acompte réglable, bornes contrôlées', async () => {
    const settings = { ...world.catalog.settings, depositPercent: 40 };
    expect((await asAdmin(() => new UpdateSettingsUseCase(world).execute(settings))).depositPercent).toBe(40);
    expect(
      await code(
        asAdmin(() => new UpdateSettingsUseCase(world).execute({ ...settings, depositPercent: 101 })),
      ),
    ).toBe('CLEANING_VALIDATION_FAILED');
  });

  it('agents, indisponibilités et équipes', async () => {
    await asAdmin(() =>
      new RegisterAgentUseCase(world).execute({ agentId: AGENT_ID, displayName: ' Awa  B. ' }),
    );
    expect(world.agents.agents.get(AGENT_ID)!.displayName).toBe('Awa B.');
    expect(
      await code(
        asAdmin(() => new RegisterAgentUseCase(world).execute({ agentId: AGENT_ID, displayName: 'Awa' })),
      ),
    ).toBe('CLEANING_AGENT_ALREADY_REGISTERED');
    const agent = await asAdmin(() =>
      new DeclareUnavailabilityUseCase(world).execute({
        agentId: AGENT_ID,
        start: '2026-11-01T00:00:00Z',
        end: '2026-11-08T00:00:00Z',
        reason: 'Congé',
      }),
    );
    expect(agent.unavailabilities).toHaveLength(1);
    expect(
      await code(
        asAdmin(() =>
          new CreateTeamUseCase(world).execute({ name: 'Équipe A', memberIds: [OTHER_AGENT_ID] }),
        ),
      ),
    ).toBe('CLEANING_AGENT_NOT_FOUND');
    const team = await asAdmin(() =>
      new CreateTeamUseCase(world).execute({ name: 'Équipe A', memberIds: [AGENT_ID] }),
    );
    expect(team.memberIds).toEqual([AGENT_ID]);
  });
});
