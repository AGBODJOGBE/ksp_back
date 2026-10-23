import { type AppError } from '@ksp/platform';
import { ListServicesUseCase, SimulateUseCase } from '../catalog/catalog.use-cases';
import {
  AGENT_ID,
  as,
  asAgent,
  asCustomer,
  asSupervisor,
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

function requestInput(key = 'k-1') {
  return {
    idempotencyKey: key,
    serviceCode: 'home_cleaning',
    premisesType: 'house',
    quantity: 6,
    options: ['windows'],
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
    world.catalog.services.set('pest_control', {
      ...homeCleaning({ unitPrice: null }),
      code: 'pest_control',
      active: false,
    });
  });

  it('liste les seules prestations actives', async () => {
    const services = await new ListServicesUseCase(world).execute();
    expect(services.map((s) => s.code)).toEqual(['home_cleaning']);
  });

  it('renvoie une fourchette et la mention non contractuelle', async () => {
    const result = await new SimulateUseCase(world).execute({
      serviceCode: 'home_cleaning',
      premisesType: 'house',
      quantity: 6,
      options: ['windows'],
      commune: 'Abomey Calavi',
      frequency: 'once',
    });
    expect(result.simulation).toMatchObject({
      priced: true,
      computedPrice: 37_400,
      low: 33_500,
      high: 43_000,
    });
    expect(result.notice).toMatch(/non contractuelle/);
  });

  it('prestation sans prix : réponse propre', async () => {
    world.catalog.services.set('home_cleaning', homeCleaning({ unitPrice: null }));
    const result = await new SimulateUseCase(world).execute({
      serviceCode: 'home_cleaning',
      premisesType: 'house',
      quantity: 6,
      options: [],
      commune: 'Cotonou',
      frequency: '',
    });
    expect(result.simulation.priced).toBe(false);
    expect(result.notice).toMatch(/pas encore publié/);
  });

  it('refuse prestation inactive, option inconnue, quantité invalide', async () => {
    const base = {
      premisesType: 'house',
      quantity: 3,
      options: [] as string[],
      commune: 'Cotonou',
      frequency: 'once',
    };
    const simulate = (input: Partial<typeof base> & { serviceCode: string }) =>
      code(new SimulateUseCase(world).execute({ ...base, ...input }));
    expect(await simulate({ serviceCode: 'pest_control' })).toBe('CLEANING_SERVICE_NOT_FOUND');
    expect(await simulate({ serviceCode: 'home_cleaning', options: ['pool'] })).toBe(
      'CLEANING_VALIDATION_FAILED',
    );
    expect(await simulate({ serviceCode: 'home_cleaning', quantity: 0 })).toBe('CLEANING_VALIDATION_FAILED');
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
    await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({ visitId: visited.visit!.id, report: 'Visite faite.' }),
    );
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
      estimate: { low: 33_500, high: 43_000 },
      recommendedTeamSize: 2,
    });
    expect(world.recorder.events).toEqual([
      {
        type: 'cleaning.quote.requested',
        payload: {
          requestId: created.id,
          customerId: CUSTOMER_ID,
          organizationId: null,
          customerKind: 'individual',
          serviceCode: 'home_cleaning',
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
    await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({
        visitId: visited.visit!.id,
        report: 'Deux étages, accès facile.',
      }),
    );
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

  it('devis prérempli depuis la grille : ajustement de commune, acompte de 30 %', async () => {
    const created = await request();
    const sent = await sendQuote(created.id);
    expect(sent.quote).toMatchObject({
      subtotal: 37_400,
      total: 37_400,
      depositPercent: 30,
      depositAmount: 11_220,
      teamSize: 2,
    });
    expect(sent.quote!.lines.at(-1)).toMatchObject({
      label: 'Ajustement commune (Abomey-Calavi)',
      amount: 3_400,
    });
    expect(sent.quote!.validUntil.toISOString()).toBe('2026-11-07T08:00:00.000Z');
  });

  it('prestation sans prix : le superviseur doit saisir les lignes', async () => {
    const created = await request();
    world.catalog.services.set('home_cleaning', homeCleaning({ unitPrice: null }));
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
    expect(first.mission.mission.payment).toMatchObject({ total: 37_400, depositAmount: 11_220 });
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

  it('entreprise : jours par semaine gardés, plan de paiement par défaut, début du contrat publié', async () => {
    const created = await as(
      CUSTOMER_ID,
      () => new RequestQuoteUseCase(world).execute({ ...requestInput(), daysPerWeek: 3 }),
      { activeContext: ORGANIZATION_ID },
    );
    expect(created.daysPerWeek).toBe(3);
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(world).execute({
        requestId: created.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    await asSupervisor(() =>
      new CompleteVisitUseCase(world).execute({ visitId: visited.visit!.id, report: 'RAS' }),
    );
    await sendQuote(created.id);
    const accepted = await as(
      CUSTOMER_ID,
      () =>
        new AcceptQuoteUseCase(world).execute({
          requestId: created.id,
          idempotencyKey: 'acc-b',
          slotStart: SLOT.start,
        }),
      { activeContext: ORGANIZATION_ID },
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
      expect.objectContaining({ outcome: 'declined', cancelledBy: 'customer' }),
      expect.objectContaining({ outcome: 'rejected', cancelledBy: 'supervisor' }),
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
});
