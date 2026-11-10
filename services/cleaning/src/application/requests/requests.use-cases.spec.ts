import { type AppError } from '@ksp/platform';
import { ListServedZonesUseCase, ListServicesUseCase, SimulateUseCase } from '../catalog/catalog.use-cases';
import {
  AGENT_ID,
  as,
  asAgent,
  asCustomer,
  asOrganizationMember,
  asSupervisor,
  asSuperAdmin,
  CUSTOMER_ID,
  homeCleaning,
  ORGANIZATION_ID,
  OTHER_CUSTOMER_ID,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import {
  CompleteVisitUseCase,
  ListQuoteRequestsUseCase,
  RejectQuoteRequestUseCase,
  ScheduleVisitUseCase,
  SendQuoteUseCase,
} from './admin-requests.use-cases';
import {
  AcceptQuoteUseCase,
  BUSINESS_PAYMENT_PLAN,
  CancelRequestUseCase,
  DeclineQuoteUseCase,
  GetMyRequestUseCase,
  ListMyRequestsUseCase,
  RequestQuoteUseCase,
} from './customer-requests.use-cases';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

const SLOT = { start: '2026-10-30T08:00:00Z', end: '2026-10-30T11:00:00Z' };
const PLAN = { option: 'deposit', timing: 'before', method: 'cash' };

/** Réponses au formulaire du nettoyage à domicile (nouveau format, ADR-033). */
const ANSWERS = {
  answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal' },
  optionSelections: [{ code: 'windows', answers: { window_count: 8 } }],
  frequency: 'once',
};
/** Même besoin à l'ancien format (déprécié) : le nouveau formulaire reste incomplet. */
const LEGACY = { premisesType: 'house', quantity: 6, options: ['windows'], frequency: 'once' };

function requestInput(key = 'k-1') {
  return {
    idempotencyKey: key,
    serviceCode: 'home_cleaning',
    ...ANSWERS,
    commune: 'Abomey-Calavi',
    address: 'Lot 12, Abomey-Calavi',
    preferredSlots: [SLOT],
    comment: 'Portail bleu',
    requestedTeamSize: 0,
  };
}

describe('simulateur et catalogue (UC-CL-01)', () => {
  let world: TestWorld;
  beforeEach(() => {
    world = testWorld();
    world.catalog.services.set('home_cleaning', homeCleaning());
    world.catalog.services.set('pest_control', homeCleaning({ code: 'pest_control', active: false }));
  });

  it('liste les seules prestations actives', async () => {
    const services = await new ListServicesUseCase(world).execute();
    expect(services.map((s) => s.code)).toEqual(['home_cleaning']);
  });

  it('zones desservies publiques : seules les actives, sans connexion, par nom de commune', async () => {
    const porto = world.catalog.zones.get('porto-novo')!;
    world.catalog.zones.set('porto-novo', { ...porto, active: false });
    const zones = await new ListServedZonesUseCase(world).execute();
    expect(zones.map((zone) => [zone.code, zone.commune])).toEqual([
      ['abomey-calavi', 'Abomey-Calavi'],
      ['cotonou', 'Cotonou'],
    ]);
  });

  it('renvoie une fourchette, le détail du calcul et la mention non contractuelle', async () => {
    const result = await new SimulateUseCase(world).execute({
      serviceCode: 'home_cleaning',
      commune: 'Abomey Calavi',
      ...ANSWERS,
    });
    expect(result.calculation).toMatchObject({
      pricingVersion: 3,
      priced: true,
      computedPrice: 35_700,
      estimate: { low: 32_000, high: 41_000 },
    });
    expect(result.notice).toMatch(/non contractuelle/);
  });

  it('prestation sans prix : réponse propre, avec les prix manquants', async () => {
    const unpriced = homeCleaning();
    unpriced.fields[1]!.pricePerUnit = null;
    world.catalog.services.set('home_cleaning', unpriced);
    const result = await new SimulateUseCase(world).execute({
      serviceCode: 'home_cleaning',
      commune: 'Cotonou',
      ...ANSWERS,
    });
    expect(result.calculation).toMatchObject({
      priced: false,
      reason: 'price_not_set',
      missingPrices: [{ optionCode: null, fieldCode: 'rooms', choiceCode: null }],
    });
    expect(result.notice).toMatch(/pas encore publié/);
  });

  it('ancien format toléré : converti, incomplet sans erreur', async () => {
    const result = await new SimulateUseCase(world).execute({
      serviceCode: 'home_cleaning',
      commune: 'Cotonou',
      ...LEGACY,
    });
    expect(result.calculation).toMatchObject({ priced: false, reason: 'answers_incomplete' });
    expect(result.notice).toMatch(/Précisez votre besoin/);
  });

  it('refuse prestation inactive, réponse invalide (champ et raison), ancien format invalide', async () => {
    const simulate = (input: object, serviceCode = 'home_cleaning') =>
      new SimulateUseCase(world).execute({ serviceCode, commune: 'Cotonou', ...input });
    const details = (input: object) =>
      simulate(input).then(
        () => null,
        (error: AppError) => [error.code, error.details],
      );
    expect(await code(simulate(ANSWERS, 'pest_control'))).toBe('CLEANING_SERVICE_NOT_FOUND');
    expect(await details({ ...ANSWERS, answers: { ...ANSWERS.answers, rooms: 0 } })).toEqual([
      'CLEANING_VALIDATION_FAILED',
      { field: 'answers.rooms', reason: 'out_of_range' },
    ]);
    expect(await details({ ...ANSWERS, optionSelections: [{ code: 'pool', answers: {} }] })).toEqual([
      'CLEANING_VALIDATION_FAILED',
      { field: 'options[0].code', reason: 'unknown_option' },
    ]);
    expect(await details({ ...ANSWERS, frequency: '' })).toEqual([
      'CLEANING_VALIDATION_FAILED',
      { field: 'frequency', reason: 'required' },
    ]);
    expect(await details({ ...LEGACY, options: ['pool'] })).toEqual([
      'CLEANING_VALIDATION_FAILED',
      { field: 'options', reason: 'unknown_option' },
    ]);
    expect(await details({ ...LEGACY, quantity: 51 })).toEqual([
      'CLEANING_VALIDATION_FAILED',
      { field: 'quantity', reason: 'out_of_range' },
    ]);
    expect(await code(simulate({ ...LEGACY, quantity: 0 }))).toBe('CLEANING_VALIDATION_FAILED');
  });
});

describe('parcours demande → devis → acceptation (UC-CL-02 à 08)', () => {
  let world: TestWorld;
  beforeEach(async () => {
    world = testWorld();
    world.catalog.services.set('home_cleaning', homeCleaning());
    world.agents.agents.set(AGENT_ID, {
      agentId: AGENT_ID,
      displayName: 'Awa',
      active: true,
      unavailabilities: [],
    });
  });

  const request = (key?: string) =>
    asCustomer(() => new RequestQuoteUseCase(world).execute(requestInput(key)));
  /** Visite des lieux planifiée puis réalisée : obligatoire avant tout devis. */
  const completeVisit = async (requestId: string) => {
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    // Le compte rendu suit la visite : l'horloge avance le temps de la visite, puis revient.
    const before = world.clock.current;
    world.clock.current = new Date('2026-10-26T11:00:00Z');
    await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({ visitId: visited.visit!.id, report: 'Visite faite.' }),
    );
    world.clock.current = before;
  };
  const sendQuote = async (requestId: string, options: { visit?: boolean } = {}) => {
    const current = world.requests.requests.get(requestId);
    if ((options.visit ?? true) && current?.visit?.status !== 'completed') await completeVisit(requestId);
    return sendQuoteOnly(requestId);
  };
  const sendQuoteOnly = (requestId: string) =>
    asSupervisor(() =>
      new SendQuoteUseCase(world).execute({
        requestId,
        lines: [],
        proposedSlots: [SLOT],
        validityDays: 0,
        teamSize: 0,
        durationMinutes: 180,
      }),
    );

  it('enregistre la demande, publie quote.requested sans adresse ni commentaire', async () => {
    const created = await request();
    expect(created).toMatchObject({
      status: 'received',
      customerKind: 'individual',
      estimate: { low: 32_000, high: 41_000 },
      recommendedTeamSize: 2,
      answers: ANSWERS.answers,
      optionSelections: ANSWERS.optionSelections,
      frequency: 'once',
      pricingVersion: 3,
      // Anciens champs, déduits des réponses.
      premisesType: 'other',
      quantity: 6,
      options: ['windows'],
    });
    expect(created.calculation).toMatchObject({ priced: true, computedPrice: 35_700 });
    expect(world.recorder.events).toEqual([
      {
        type: 'cleaning.quote.requested',
        payload: {
          requestId: created.id,
          customerId: CUSTOMER_ID,
          organizationId: null,
          customerKind: 'individual',
          serviceCode: 'home_cleaning',
          serviceName: 'Nettoyage à domicile',
          visitRequired: true,
        },
      },
    ]);
    expect(JSON.stringify(world.recorder.changes)).not.toContain('Lot 12');
  });

  it('idempotence : la même clé ne crée qu’une demande', async () => {
    const first = await request('same');
    const second = await request('same');
    expect(second.id).toBe(first.id);
    expect(world.requests.requests.size).toBe(1);
  });

  it('visite des lieux obligatoire avant le devis (entreprise comme particulier)', async () => {
    const created = await as(CUSTOMER_ID, () => new RequestQuoteUseCase(world).execute(requestInput()), {
      activeContext: ORGANIZATION_ID,
      orgRole: 'org_member',
    });
    expect(created).toMatchObject({ customerKind: 'business', organizationId: ORGANIZATION_ID });
    expect(await code(sendQuote(created.id, { visit: false }))).toBe('CLEANING_VISIT_REQUIRED');

    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId: created.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    expect(visited.status).toBe('visit_scheduled');
    world.clock.current = new Date('2026-10-26T11:00:00Z');
    await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({
        visitId: visited.visit!.id,
        report: 'Deux étages, accès facile.',
      }),
    );
    world.clock.current = new Date('2026-10-23T08:00:00Z');
    expect((await sendQuote(created.id)).status).toBe('quote_sent');
    expect(world.recorder.events.map((e) => e.type)).toEqual([
      'cleaning.quote.requested',
      'cleaning.visit.scheduled',
      'cleaning.quote.sent',
    ]);
  });

  it('particulier : devis refusé sans visite réalisée ; demande hors zone refusée', async () => {
    const created = await request();
    expect(await code(sendQuote(created.id, { visit: false }))).toBe('CLEANING_VISIT_REQUIRED');
    const outside = { ...requestInput('k-zone'), commune: 'Parakou' };
    expect(await code(asCustomer(() => new RequestQuoteUseCase(world).execute(outside)))).toBe(
      'CLEANING_ZONE_NOT_COVERED',
    );
  });

  it('refuse un créneau trop proche, et au-delà de 5 demandes ouvertes', async () => {
    const tooSoon = {
      ...requestInput(),
      preferredSlots: [{ start: '2026-10-24T08:00:00Z', end: '2026-10-24T10:00:00Z' }],
    };
    expect(await code(asCustomer(() => new RequestQuoteUseCase(world).execute(tooSoon)))).toBe(
      'CLEANING_LEAD_TIME_TOO_SHORT',
    );
    for (let i = 0; i < 5; i += 1) await request(`k-${i}`);
    expect(await code(request('k-6'))).toBe('CLEANING_TOO_MANY_OPEN_REQUESTS');
  });

  it('devis prérempli depuis le détail du calcul : ajustement des coefficients, acompte de 30 %', async () => {
    const created = await request();
    const sent = await sendQuote(created.id);
    expect(sent.quote).toMatchObject({
      subtotal: 35_700,
      total: 35_700,
      depositPercent: 30,
      depositAmount: 10_710,
      teamSize: 2,
    });
    expect(sent.quote!.lines.at(-1)).toMatchObject({
      label: 'Ajustement : Abomey-Calavi',
      amount: 1_700,
    });
    expect(sent.quote!.validUntil.toISOString()).toBe('2026-11-07T08:00:00.000Z');
  });

  it('prestation sans prix : le superviseur doit saisir les lignes', async () => {
    const unpriced = homeCleaning();
    unpriced.fields[1]!.pricePerUnit = null;
    world.catalog.services.set('home_cleaning', unpriced);
    const created = await request();
    expect(created.calculation).toMatchObject({ priced: false, reason: 'price_not_set' });
    expect(await code(sendQuote(created.id))).toBe('CLEANING_PRICE_NOT_SET');
    // Prix fixé depuis : nouveau calcul avec la grille en vigueur et les réponses enregistrées.
    world.catalog.services.set('home_cleaning', homeCleaning());
    expect((await sendQuoteOnly(created.id)).quote).toMatchObject({ subtotal: 35_700 });
  });

  it('devis à 0 FCFA refusé : une remise ne peut pas annuler le prix (ADR-049)', async () => {
    const created = await request();
    await completeVisit(created.id);
    const send = (lines: { label: string; quantity: number; unitPrice: number; amount: number }[]) =>
      asSupervisor(() =>
        new SendQuoteUseCase(world).execute({
          requestId: created.id,
          lines,
          proposedSlots: [SLOT],
          validityDays: 0,
          teamSize: 0,
          durationMinutes: 180,
        }),
      );
    const service = { label: 'Nettoyage', quantity: 1, unitPrice: 20_000, amount: 20_000 };
    const discount = { label: 'Remise', quantity: 1, unitPrice: -20_000, amount: -20_000 };
    expect(await code(send([service, discount]))).toBe('CLEANING_VALIDATION_FAILED');
    expect((await send([service, { ...discount, unitPrice: -5_000, amount: -5_000 }])).quote).toMatchObject({
      subtotal: 15_000,
    });
  });

  it('ancien format : demande enregistrée (réponses converties), devis à saisir par le superviseur', async () => {
    const legacy = { ...requestInput('legacy'), answers: undefined, optionSelections: [], ...LEGACY };
    const created = await asCustomer(() => new RequestQuoteUseCase(world).execute(legacy));
    expect(created).toMatchObject({
      answers: { rooms: 6 },
      optionSelections: [{ code: 'windows', answers: {} }],
      estimate: null,
      premisesType: 'other',
      quantity: 6,
    });
    expect(created.calculation).toMatchObject({ priced: false, reason: 'answers_incomplete' });
    expect(await code(sendQuote(created.id))).toBe('CLEANING_PRICE_NOT_SET');
  });

  it('acceptation : mission créée, booking.confirmed, double acceptation sans doublon', async () => {
    const created = await request();
    await sendQuote(created.id);
    const accept = (key: string) =>
      asCustomer(() =>
        new AcceptQuoteUseCase(world).execute({
          requestId: created.id,
          idempotencyKey: key,
          slotStart: SLOT.start,
          paymentPlan: PLAN,
        }),
      );
    const first = await accept('acc-1');
    expect(first.request.status).toBe('accepted');
    expect(first.mission.mission).toMatchObject({ status: 'to_schedule', plannedInterventions: 1 });
    expect(first.mission.mission.payment).toMatchObject({ total: 35_700, depositAmount: 10_710 });
    const again = await accept('acc-1');
    expect(again.mission.mission.id).toBe(first.mission.mission.id);
    expect(world.missions.missions.size).toBe(1);
    expect(await code(accept('acc-2'))).toBe('CLEANING_INVALID_TRANSITION');
    expect(world.recorder.events.filter((e) => e.type === 'cleaning.booking.confirmed')).toHaveLength(1);
  });

  it('visite des lieux possible pour un particulier, même après l’envoi du devis (partie 10)', async () => {
    const created = await request();
    await sendQuote(created.id);
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId: created.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    expect(visited.status).toBe('visit_scheduled');
    // Le client ne peut plus accepter : le devis sera renvoyé après la visite.
    expect(
      await code(
        asCustomer(() =>
          new AcceptQuoteUseCase(world).execute({
            requestId: created.id,
            idempotencyKey: 'acc-v',
            slotStart: SLOT.start,
            paymentPlan: PLAN,
          }),
        ),
      ),
    ).toBe('CLEANING_INVALID_TRANSITION');
    expect((await sendQuote(created.id)).status).toBe('quote_sent');
  });

  it('particulier : plan de paiement obligatoire, erreur claire s’il manque', async () => {
    const created = await request();
    await sendQuote(created.id);
    const failure = await asCustomer(() =>
      new AcceptQuoteUseCase(world).execute({
        requestId: created.id,
        idempotencyKey: 'sans-plan',
        slotStart: SLOT.start,
      }),
    ).catch((error: AppError) => error);
    expect(failure).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'paymentPlan' },
      message: expect.stringMatching(/option de paiement/),
    });
    // Message absent sur le fil (décodé à null par le serveur gRPC) ou plan vide : même refus.
    for (const [key, paymentPlan] of [
      ['plan-null', null as never],
      ['plan-vide', { option: '', timing: '', method: '' }],
    ] as const) {
      expect(
        await code(
          asCustomer(() =>
            new AcceptQuoteUseCase(world).execute({
              requestId: created.id,
              idempotencyKey: key,
              slotStart: SLOT.start,
              paymentPlan,
            }),
          ),
        ),
      ).toBe('CLEANING_VALIDATION_FAILED');
    }
    expect(world.missions.missions.size).toBe(0);
  });

  it('particulier : Mobile Money en ligne accepté comme moyen prévu à l’acceptation', async () => {
    const created = await request();
    await sendQuote(created.id);
    const accepted = await asCustomer(() =>
      new AcceptQuoteUseCase(world).execute({
        requestId: created.id,
        idempotencyKey: 'plan-en-ligne',
        slotStart: SLOT.start,
        paymentPlan: { option: 'deposit', timing: 'before', method: 'mobile_money_online' },
      }),
    );
    expect(accepted.mission.mission.payment.plan).toEqual({
      option: 'deposit',
      timing: 'before',
      method: 'mobile_money_online',
    });
    const booking = world.recorder.events.find((e) => e.type === 'cleaning.booking.confirmed');
    expect(booking?.payload).toMatchObject({ paymentPlan: { method: 'mobile_money_online' } });
  });

  it('entreprise : jours par semaine gardés, plan de paiement par défaut, début du contrat publié', async () => {
    const created = await as(
      CUSTOMER_ID,
      () => new RequestQuoteUseCase(world).execute({ ...requestInput(), daysPerWeek: 3 }),
      { activeContext: ORGANIZATION_ID, orgRole: 'org_member' },
    );
    expect(created.daysPerWeek).toBe(3);
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId: created.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    world.clock.current = new Date('2026-10-26T11:00:00Z');
    await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({ visitId: visited.visit!.id, report: 'RAS' }),
    );
    world.clock.current = new Date('2026-10-23T08:00:00Z');
    await sendQuote(created.id);
    const accepted = await as(
      CUSTOMER_ID,
      () =>
        new AcceptQuoteUseCase(world).execute({
          requestId: created.id,
          idempotencyKey: 'acc-b',
          slotStart: SLOT.start,
        }),
      { activeContext: ORGANIZATION_ID, orgRole: 'org_member' },
    );
    expect(accepted.mission.mission).toMatchObject({ daysPerWeek: 3, suspension: null });
    expect(accepted.mission.mission.payment.plan).toEqual({
      option: 'full',
      timing: 'after',
      method: 'cash',
    });
    const booking = world.recorder.events.find((e) => e.type === 'cleaning.booking.confirmed');
    expect(booking?.payload).toMatchObject({
      organizationId: ORGANIZATION_ID,
      startsAt: '2026-10-30T08:00:00.000Z',
    });
    expect(
      await code(
        asCustomer(() => new RequestQuoteUseCase(world).execute({ ...requestInput('k-8'), daysPerWeek: 8 })),
      ),
    ).toBe('CLEANING_VALIDATION_FAILED');
  });

  it('entreprise : un plan de paiement envoyé est ignoré (règlement par facture mensuelle)', async () => {
    const created = await as(CUSTOMER_ID, () => new RequestQuoteUseCase(world).execute(requestInput()), {
      activeContext: ORGANIZATION_ID,
      orgRole: 'org_member',
    });
    await sendQuote(created.id);
    const accepted = await as(
      CUSTOMER_ID,
      () =>
        new AcceptQuoteUseCase(world).execute({
          requestId: created.id,
          idempotencyKey: 'acc-b-plan',
          slotStart: SLOT.start,
          paymentPlan: { option: 'deposit', timing: 'before', method: 'mobile_money_online' },
        }),
      { activeContext: ORGANIZATION_ID, orgRole: 'org_member' },
    );
    expect(accepted.mission.mission.payment.plan).toEqual(BUSINESS_PAYMENT_PLAN);
    expect(accepted.mission.mission.payment).toMatchObject({ depositPercent: 100 });
  });

  it('organisation suspendue par KSP : ni demande ni acceptation en son nom (ADR-030)', async () => {
    const created = await as(CUSTOMER_ID, () => new RequestQuoteUseCase(world).execute(requestInput()), {
      activeContext: ORGANIZATION_ID,
      orgRole: 'org_member',
    });
    await sendQuote(created.id);
    await world.organizations.record({
      eventId: '0192f1c4-7a2b-7c3d-8e4f-000000008001',
      consumer: 'cleaning.identity.organization.suspended',
      organizationId: ORGANIZATION_ID,
      suspended: true,
      at: new Date('2026-10-23T07:00:00Z'),
    });
    // Jeton émis avant la suspension, encore valable : la nouvelle demande est refusée.
    expect(
      await code(
        as(CUSTOMER_ID, () => new RequestQuoteUseCase(world).execute(requestInput('k-org')), {
          activeContext: ORGANIZATION_ID,
          orgRole: 'org_member',
        }),
      ),
    ).toBe('CLEANING_ORGANIZATION_SUSPENDED');
    // Acceptation dans le contexte de l'organisation (ADR-049) : c'est la demande qui la porte.
    expect(
      await code(
        asOrganizationMember(() =>
          new AcceptQuoteUseCase(world).execute({
            requestId: created.id,
            idempotencyKey: 'acc-org',
            slotStart: SLOT.start,
          }),
        ),
      ),
    ).toBe('CLEANING_ORGANIZATION_SUSPENDED');
    expect(world.missions.missions.size).toBe(0);
    // Le particulier, lui, n'est pas concerné.
    expect((await request('k-perso')).customerKind).toBe('individual');
  });

  it('demande d’organisation : son contexte actif exigé ; agir en son nom exige org_admin ou org_member', async () => {
    expect(
      await code(
        asOrganizationMember(() => new RequestQuoteUseCase(world).execute(requestInput()), 'org_viewer'),
      ),
    ).toBe('AUTH_FORBIDDEN');
    const created = await asOrganizationMember(() => new RequestQuoteUseCase(world).execute(requestInput()));
    const list = () => new ListMyRequestsUseCase(world).execute({ limit: 20, cursor: null });
    expect((await asCustomer(list)).items).toEqual([]);
    expect((await asOrganizationMember(list)).items.map((r) => r.id)).toEqual([created.id]);
    await sendQuote(created.id);
    // Contexte personnel : la demande de l'organisation est introuvable (404, ADR-049).
    expect(await code(asCustomer(() => new GetMyRequestUseCase(world).execute(created.id)))).toBe(
      'CLEANING_REQUEST_NOT_FOUND',
    );
    const accept = () =>
      new AcceptQuoteUseCase(world).execute({
        requestId: created.id,
        idempotencyKey: 'acc-o',
        slotStart: SLOT.start,
      });
    expect(await code(asCustomer(accept))).toBe('CLEANING_REQUEST_NOT_FOUND');
    // Membre lecteur : il consulte, mais n'accepte ni ne refuse.
    expect(
      await code(
        asOrganizationMember(() => new GetMyRequestUseCase(world).execute(created.id), 'org_viewer'),
      ),
    ).toBe('ok');
    expect(await code(asOrganizationMember(accept, 'org_viewer'))).toBe('AUTH_FORBIDDEN');
    expect(
      await code(
        asOrganizationMember(
          () => new DeclineQuoteUseCase(world).execute({ requestId: created.id, reason: '' }),
          'org_viewer',
        ),
      ),
    ).toBe('AUTH_FORBIDDEN');
    expect((await asOrganizationMember(accept)).mission.mission.organizationId).toBe(ORGANIZATION_ID);
  });

  it('devis expiré : refus CLEANING_QUOTE_EXPIRED', async () => {
    const created = await request();
    await sendQuote(created.id);
    world.clock.current = new Date('2026-11-08T00:00:00Z');
    const result = asCustomer(() =>
      new AcceptQuoteUseCase(world).execute({
        requestId: created.id,
        idempotencyKey: 'late',
        slotStart: SLOT.start,
        paymentPlan: PLAN,
      }),
    );
    expect(await code(result)).toBe('CLEANING_QUOTE_EXPIRED');
    expect((await asCustomer(() => new GetMyRequestUseCase(world).execute(created.id))).status).toBe(
      'expired',
    );
  });

  it('créneau non proposé et option de paiement invalide refusés', async () => {
    const created = await request();
    await sendQuote(created.id);
    const accept = (slotStart: string, paymentPlan = PLAN) =>
      code(
        asCustomer(() =>
          new AcceptQuoteUseCase(world).execute({
            requestId: created.id,
            idempotencyKey: 'x',
            slotStart,
            paymentPlan,
          }),
        ),
      );
    expect(await accept('2026-10-30T09:00:00Z')).toBe('CLEANING_SLOT_INVALID');
    expect(await accept(SLOT.start, { ...PLAN, method: 'cheque' })).toBe('CLEANING_VALIDATION_FAILED');
  });

  it('un client ne voit ni ne modifie la demande d’un autre (404)', async () => {
    const created = await request();
    const other = <T>(fn: () => T) => asCustomer(fn, OTHER_CUSTOMER_ID);
    expect(await code(other(() => new GetMyRequestUseCase(world).execute(created.id)))).toBe(
      'CLEANING_REQUEST_NOT_FOUND',
    );
    expect(
      await code(other(() => new CancelRequestUseCase(world).execute({ requestId: created.id, reason: '' }))),
    ).toBe('CLEANING_REQUEST_NOT_FOUND');
    const mine = await other(() => new ListMyRequestsUseCase(world).execute({ limit: 20, cursor: null }));
    expect(mine.items).toEqual([]);
  });

  it('refus du devis puis annulation impossible ; refus par KSP avec motif', async () => {
    const declinedRequest = await request('a');
    await sendQuote(declinedRequest.id);
    const declined = await asCustomer(() =>
      new DeclineQuoteUseCase(world).execute({ requestId: declinedRequest.id, reason: 'Trop cher' }),
    );
    expect(declined).toMatchObject({ status: 'declined', closingReason: 'Trop cher' });
    expect(
      await code(
        asCustomer(() =>
          new CancelRequestUseCase(world).execute({ requestId: declinedRequest.id, reason: '' }),
        ),
      ),
    ).toBe('CLEANING_INVALID_TRANSITION');

    const other = await request('b');
    expect(
      await code(
        asSupervisor(() => new RejectQuoteRequestUseCase(world).execute({ requestId: other.id, reason: '' })),
      ),
    ).toBe('CLEANING_VALIDATION_FAILED');
    const rejected = await asSupervisor(() =>
      new RejectQuoteRequestUseCase(world).execute({ requestId: other.id, reason: 'Zone non desservie' }),
    );
    expect(rejected.status).toBe('rejected');
    expect(
      world.recorder.events.filter((e) => e.type === 'cleaning.request.cancelled').map((e) => e.payload),
    ).toEqual([
      expect.objectContaining({ outcome: 'declined', cancelledBy: 'customer', organizationId: null }),
      expect.objectContaining({ outcome: 'rejected', cancelledBy: 'supervisor', organizationId: null }),
    ]);
  });

  it('back-office : rôle et double authentification exigés', async () => {
    const list = () =>
      new ListQuoteRequestsUseCase(world).execute({ page: { limit: 20, cursor: null }, status: '' });
    expect(await code(asCustomer(list))).toBe('AUTH_FORBIDDEN');
    expect(await code(as(AGENT_ID, list, { roles: ['cleaning_supervisor'], mfa: false }))).toBe(
      'AUTH_MFA_REQUIRED',
    );
    expect(await code(asAgent(list))).toBe('AUTH_FORBIDDEN');
    expect(await code(asSupervisor(list))).toBe('ok');
  });

  it('super_admin : même portée que cleaning_admin, double authentification exigée', async () => {
    const list = () =>
      new ListQuoteRequestsUseCase(world).execute({ page: { limit: 20, cursor: null }, status: '' });
    expect(await code(asSuperAdmin(list))).toBe('ok');
    expect(await code(asSuperAdmin(list, false))).toBe('AUTH_MFA_REQUIRED');
  });

  it('liste du back-office : filtres zone et type de client, cumulables avec l’état, paginés', async () => {
    const individual = await request('ind-1');
    await asCustomer(() =>
      new RequestQuoteUseCase(world).execute({ ...requestInput('ind-2'), commune: 'Cotonou' }),
    );
    const business = await as(
      OTHER_CUSTOMER_ID,
      () => new RequestQuoteUseCase(world).execute({ ...requestInput('biz-1'), commune: 'Abomey Calavi' }),
      { activeContext: ORGANIZATION_ID, orgRole: 'org_member' },
    );
    const list = (filters: { status?: string; commune?: string; customerKind?: string }, limit = 20) =>
      asSupervisor(() =>
        new ListQuoteRequestsUseCase(world).execute({
          page: { limit, cursor: null },
          status: filters.status ?? '',
          commune: filters.commune ?? '',
          customerKind: filters.customerKind ?? '',
        }),
      );
    const ids = async (filters: Parameters<typeof list>[0]) => (await list(filters)).items.map((r) => r.id);

    expect((await ids({ commune: 'abomey-calavi' })).sort()).toEqual([individual.id, business.id].sort());
    expect(await ids({ commune: 'abomey-calavi', customerKind: 'business' })).toEqual([business.id]);
    expect(await ids({ commune: 'abomey-calavi', customerKind: 'individual', status: 'received' })).toEqual([
      individual.id,
    ]);
    expect(await ids({ commune: 'abomey-calavi', status: 'quote_sent' })).toEqual([]);
    expect(await ids({ commune: 'porto-novo' })).toEqual([]);
    const firstPage = await list({ commune: 'abomey-calavi' }, 1);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();

    expect(await code(list({ customerKind: 'company' }))).toBe('CLEANING_VALIDATION_FAILED');
    expect(await code(list({ commune: '--' }))).toBe('CLEANING_VALIDATION_FAILED');
  });

  it('compte rendu de visite refusé avant l’heure prévue (règle réglable)', async () => {
    const created = await request();
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId: created.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    const complete = () =>
      asSupervisor(() =>
        new CompleteVisitUseCase(world).execute({ visitId: visited.visit!.id, report: 'Visite faite.' }),
      );
    world.clock.current = new Date('2026-10-26T08:59:00Z');
    const error = await complete().catch((e: AppError) => e);
    expect(error).toMatchObject({
      code: 'CLEANING_VISIT_TOO_EARLY',
      message:
        'La visite est prévue le 26 octobre 2026 à 10:00 : son compte rendu ne peut pas être enregistré avant cette heure.',
      details: { scheduledAt: '2026-10-26T09:00:00.000Z', timeZone: 'Africa/Porto-Novo' },
    });
    world.fieldDates.blockEarlyVisitReport = false;
    expect((await complete()).visit?.status).toBe('completed');
  });

  it('compte rendu à l’heure prévue de la visite : accepté', async () => {
    const created = await request();
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId: created.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    world.clock.current = new Date('2026-10-26T09:00:00Z');
    const done = await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({ visitId: visited.visit!.id, report: 'Visite faite.' }),
    );
    expect(done.visit?.status).toBe('completed');
  });
});
