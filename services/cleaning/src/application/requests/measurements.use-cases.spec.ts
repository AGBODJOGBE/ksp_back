import { type AppError } from '@ksp/platform';
import { gardenService } from '../../domain/testing';
import {
  CompleteGroupVisitUseCase,
  ListVisitsUseCase,
  ScheduleGroupVisitUseCase,
} from '../groups/group-visits.use-cases';
import { SendGroupQuotesUseCase } from '../groups/group-quotes.use-cases';
import { GetRequestGroupUseCase } from '../groups/group-totals.use-case';
import { DescribeRequestsUseCase } from '../places/request-labels.use-case';
import { RequestQuoteGroupUseCase } from '../places/request-groups.use-cases';
import {
  AGENT_ID,
  asAgent,
  asCustomer,
  asSupervisor,
  homeCleaning,
  OTHER_AGENT_ID,
  placeType,
  SUPERVISOR_ID,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import { CompleteVisitUseCase, ScheduleVisitUseCase, SendQuoteUseCase } from './admin-requests.use-cases';
import { RequestQuoteUseCase } from './customer-requests.use-cases';
import { EstimateRequestPriceUseCase, SaveMeasurementsUseCase } from './measurements.use-cases';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

const SLOT = { start: '2026-10-30T08:00:00Z', end: '2026-10-30T11:00:00Z' };
const VISIT_AT = '2026-10-26T09:00:00Z';
/** Réponses du client : 6 pièces, 1 salle de bain, 8 fenêtres (34 000 × 1,05 à Abomey-Calavi). */
const CLIENT = {
  answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal' },
  optionSelections: [{ code: 'windows', answers: { window_count: 8 } }],
  frequency: 'once',
};
/** Mesures constatées : 8 pièces, très sale (43 000 × 1,5 × 1,05 = 67 725). */
const MEASURED = {
  answers: { housing_type: 'apartment', rooms: 8, bathrooms: 1, condition: 'very_dirty' },
  optionSelections: [{ code: 'windows', answers: { window_count: 8 } }],
  frequency: 'once',
};

describe('mesures constatées et recalcul après la visite (ADR-037)', () => {
  let w: TestWorld;
  let requestId: string;
  let visitId: string;

  beforeEach(async () => {
    w = testWorld();
    w.catalog.services.set('home_cleaning', homeCleaning());
    for (const agentId of [AGENT_ID, OTHER_AGENT_ID]) {
      w.agents.agents.set(agentId, { agentId, displayName: 'Awa', active: true, unavailabilities: [] });
    }
    const created = await asCustomer(() =>
      new RequestQuoteUseCase(w).execute({
        idempotencyKey: 'k-measure',
        serviceCode: 'home_cleaning',
        ...CLIENT,
        commune: 'Abomey-Calavi',
        address: 'Lot 12, Abomey-Calavi',
        preferredSlots: [SLOT],
        comment: '',
        requestedTeamSize: 0,
      }),
    );
    requestId = created.id;
    const scheduled = await asSupervisor(() =>
      new ScheduleVisitUseCase(w).execute({ requestId, scheduledAt: VISIT_AT, agentId: AGENT_ID }),
    );
    visitId = scheduled.visit!.id;
  });

  const atVisit = async <T>(fn: () => Promise<T>) => {
    const before = w.clock.current;
    w.clock.current = new Date('2026-10-26T10:00:00Z');
    try {
      return await fn();
    } finally {
      w.clock.current = before;
    }
  };
  const complete = (measurements?: object, run = asAgent) =>
    atVisit(() =>
      run(() =>
        new CompleteVisitUseCase(w).execute({
          visitId,
          report: 'Visite faite.',
          measurements: measurements as never,
        }),
      ),
    );
  const sendQuote = () =>
    asSupervisor(() =>
      new SendQuoteUseCase(w).execute({
        requestId,
        lines: [],
        proposedSlots: [SLOT],
        validityDays: 0,
        teamSize: 0,
        durationMinutes: 180,
      }),
    );
  const estimate = (input: object, run: typeof asAgent = asSupervisor) =>
    run(() => new EstimateRequestPriceUseCase(w).execute({ requestId, ...input }));
  const save = (input: object, run: typeof asAgent = asSupervisor) =>
    run(() => new SaveMeasurementsUseCase(w).execute({ requestId, ...input }));

  it('recalcul sans enregistrement : commune de la demande, grille en vigueur, rien de tracé', async () => {
    const result = await estimate(MEASURED);
    expect(result).toMatchObject({
      requestId,
      serviceCode: 'home_cleaning',
      commune: 'Abomey-Calavi',
      calculation: {
        pricingVersion: 3,
        priced: true,
        computedPrice: 67_725,
        recommendedTeamSize: 3,
        missingPrices: [],
      },
    });
    expect(result.calculation.coefficients.map((c) => c.source)).toEqual(['choice', 'commune', 'frequency']);
    expect(w.recorder.changes).toHaveLength(2); // demande et visite seulement
    expect(w.requests.requests.get(requestId)!.measurement).toBeUndefined();

    // Prix non fixé : même réponse que la simulation, avec les prix manquants.
    const unpriced = homeCleaning();
    unpriced.fields[1]!.pricePerUnit = null;
    w.catalog.services.set('home_cleaning', unpriced);
    expect((await estimate(MEASURED)).calculation).toMatchObject({
      priced: false,
      reason: 'price_not_set',
      missingPrices: [{ optionCode: null, fieldCode: 'rooms', choiceCode: null }],
    });
  });

  it('recalcul : erreurs de validation au format existant, agent de la visite seul', async () => {
    const error = await estimate({ ...MEASURED, answers: { ...MEASURED.answers, rooms: 999 } }).catch(
      (caught: AppError) => caught,
    );
    expect(error).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'answers.rooms', reason: 'out_of_range' },
    });
    expect(
      await estimate({ optionSelections: [] }).catch((caught: AppError) => caught.details),
    ).toMatchObject({ field: 'answers', reason: 'required' });
    // Agent affecté à la visite : autorisé ; un autre agent : demande introuvable.
    expect((await estimate(MEASURED, asAgent)).calculation.computedPrice).toBe(67_725);
    expect(
      await code(
        asAgent(() => new EstimateRequestPriceUseCase(w).execute({ requestId, ...MEASURED }), OTHER_AGENT_ID),
      ),
    ).toBe('CLEANING_REQUEST_NOT_FOUND');
  });

  it('mesures au compte rendu : enregistrées à part, réponses du client intactes, tracées', async () => {
    const done = await complete(MEASURED);
    expect(done.visit?.status).toBe('completed');
    expect(done.answers).toEqual(CLIENT.answers);
    expect(w.requests.requests.get(requestId)!.calculation).toMatchObject({ computedPrice: 35_700 });
    expect(w.requests.requests.get(requestId)!.measurement).toMatchObject({
      answers: MEASURED.answers,
      optionSelections: MEASURED.optionSelections,
      frequency: 'once',
      pricingVersion: 3,
      measuredBy: AGENT_ID,
      calculation: { priced: true, computedPrice: 67_725 },
    });
    const audit = w.recorder.changes.at(-1)!.audit;
    expect(audit.map((entry) => entry.action)).toEqual(['visit.completed', 'request.measured']);
    expect(audit[1]).toMatchObject({
      actorId: AGENT_ID,
      details: {
        source: 'visit',
        replaced: false,
        pricingVersion: 3,
        priced: true,
        computedPrice: 67_725,
        byAgent: true,
      },
    });
    expect(JSON.stringify(audit)).not.toContain('Lot 12');
  });

  it('mesures au compte rendu invalides : rien n’est enregistré, champ préfixé', async () => {
    const error = await complete({ answers: { rooms: 8 } }).catch((caught: AppError) => caught);
    expect(error).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'measurements.answers.housing_type', reason: 'required' },
    });
    expect(w.requests.requests.get(requestId)!.visit?.status).toBe('scheduled');
  });

  it('correction après la visite, puis devis prérempli depuis les mesures', async () => {
    await complete();
    expect(w.requests.requests.get(requestId)!.measurement).toBeUndefined();
    // L'agent de la visite corrige, puis le superviseur remplace ses mesures.
    expect(
      (await save({ ...CLIENT, answers: { ...CLIENT.answers, rooms: 7 } }, asAgent)).measurement,
    ).toMatchObject({
      measuredBy: AGENT_ID,
    });
    const corrected = await save(MEASURED);
    expect(corrected.measurement).toMatchObject({
      measuredBy: SUPERVISOR_ID,
      calculation: { computedPrice: 67_725 },
    });
    expect(corrected.answers).toEqual(CLIENT.answers);
    expect(w.recorder.changes.at(-1)!.audit[0]).toMatchObject({
      action: 'request.measured',
      details: { source: 'correction', replaced: true, byAgent: false },
    });

    const sent = await sendQuote();
    expect(sent.quote).toMatchObject({ subtotal: 67_725, teamSize: 3 });
    expect(sent.quote!.lines[0]).toMatchObject({ label: 'Nombre de pièces', quantity: 8 });
    expect(w.recorder.changes.at(-1)!.audit[0]!.details).toMatchObject({ prefilledFrom: 'measurement' });
  });

  it('mesures sans prix : nouveau calcul avec la grille en vigueur, sinon CLEANING_PRICE_NOT_SET', async () => {
    const unpriced = homeCleaning();
    unpriced.fields[1]!.pricePerUnit = null;
    w.catalog.services.set('home_cleaning', unpriced);
    await complete(MEASURED);
    expect(w.requests.requests.get(requestId)!.measurement?.calculation.priced).toBe(false);
    // Les mesures remplacent les réponses du client, même si celles-ci étaient chiffrées.
    expect(await code(sendQuote())).toBe('CLEANING_PRICE_NOT_SET');
    w.catalog.services.set('home_cleaning', homeCleaning());
    expect((await sendQuote()).quote).toMatchObject({ subtotal: 67_725 });
  });

  it('refus après l’envoi du devis ; agent non affecté refusé', async () => {
    await complete();
    expect(await code(save(MEASURED, (fn) => asAgent(fn, OTHER_AGENT_ID)))).toBe(
      'CLEANING_REQUEST_NOT_FOUND',
    );
    await sendQuote();
    const error = await save(MEASURED).catch((caught: AppError) => caught);
    expect(error).toMatchObject({ code: 'CLEANING_MEASUREMENTS_LOCKED', details: { status: 'quote_sent' } });
    expect(await code(save(MEASURED, asAgent))).toBe('CLEANING_MEASUREMENTS_LOCKED');
    // Nouvelle visite demandée avant l'acceptation : les mesures peuvent être corrigées.
    await asSupervisor(() =>
      new ScheduleVisitUseCase(w).execute({
        requestId,
        scheduledAt: '2026-10-28T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    expect((await save(MEASURED)).measurement).toBeTruthy();
  });

  it('réponses lisibles : version de grille utilisée, mesures au back-office seulement', async () => {
    await complete(MEASURED);
    // Nouvelle version : le libellé change, la demande garde celui de sa version (3).
    const renamed = homeCleaning();
    w.catalog.history.push(homeCleaning());
    renamed.fields[1] = { ...renamed.fields[1]!, label: 'Pièces à nettoyer' };
    w.catalog.services.set('home_cleaning', { ...renamed, pricing: { ...renamed.pricing, version: 4 } });
    const request = w.requests.requests.get(requestId)!;

    const backoffice = await asSupervisor(() =>
      new DescribeRequestsUseCase(w).execute([request], 'backoffice'),
    );
    const summaries = backoffice.summaries.get(requestId)!;
    expect(summaries.answers.fields.map((field) => [field.label, field.display])).toEqual([
      ['Type de logement', 'Appartement'],
      ['Nombre de pièces', '6 pièces'],
      ['Nombre de salles de bain', '1 salles de bain'],
      ['État', 'Normal'],
    ]);
    expect(summaries.answers.options).toEqual([
      {
        optionCode: 'windows',
        label: 'Vitres',
        fields: [
          {
            code: 'window_count',
            label: 'Nombre de fenêtres',
            type: 'number',
            value: 8,
            display: '8 fenêtres',
            unitLabel: 'fenêtres',
          },
        ],
      },
    ]);
    expect(summaries.answers.frequency).toEqual({ code: 'once', label: 'Une fois' });
    expect(summaries.measured?.fields.find((field) => field.code === 'condition')?.display).toBe('Très sale');

    const customer = await asCustomer(() => new DescribeRequestsUseCase(w).execute([request]));
    expect(customer.audience).toBe('customer');
    expect(customer.summaries.get(requestId)).toMatchObject({ measured: null });
  });

  it('agent seul : jamais de montant au compte rendu ni à la correction des mesures ; supervision : tout', async () => {
    const done = await complete(MEASURED);
    // L'agent reçoit ses réponses et ses mesures, sans calcul, fourchette ni devis.
    expect(done).toMatchObject({
      withAmounts: false,
      calculation: null,
      estimate: null,
      quote: null,
      measurement: { answers: MEASURED.answers, measuredBy: AGENT_ID },
    });
    const corrected = await save(CLIENT, asAgent);
    expect(corrected).toMatchObject({ withAmounts: false, calculation: null, estimate: null, quote: null });
    expect(corrected.measurement).toMatchObject({ answers: CLIENT.answers });
    // Rien n'est perdu : la demande garde son calcul, et son outil de saisie lui donne le prix.
    expect(w.requests.requests.get(requestId)!.calculation).toMatchObject({ computedPrice: 35_700 });
    expect((await estimate(MEASURED, asAgent)).calculation.computedPrice).toBe(67_725);

    const bySupervision = await save(MEASURED);
    expect(bySupervision).toMatchObject({
      withAmounts: true,
      calculation: { computedPrice: 35_700 },
      measurement: { calculation: { computedPrice: 67_725 } },
    });
  });

  it('liste des visites : réponses du client et mesures ; montants à la supervision seulement', async () => {
    await complete(MEASURED);
    const PAGE = { limit: 20, cursor: null };

    const forAgent = await asAgent(() => new ListVisitsUseCase(w).execute({ page: PAGE }));
    expect(forAgent.items).toHaveLength(1);
    const seen = forAgent.items[0]!.requests[0]!;
    expect(seen).toMatchObject({
      id: requestId,
      withAmounts: false,
      answers: CLIENT.answers,
      optionSelections: CLIENT.optionSelections,
      frequency: 'once',
      pricingVersion: 3,
      measurement: { answers: MEASURED.answers, frequency: 'once', measuredBy: AGENT_ID },
      // Aucun montant de la demande pour l'agent ; le calcul des mesures est retiré à la présentation.
      calculation: null,
      estimate: null,
      quote: null,
    });
    // Le recalcul reste ouvert à l'agent de la visite.
    expect((await estimate(MEASURED, asAgent)).calculation.computedPrice).toBe(67_725);

    const forSupervision = await asSupervisor(() => new ListVisitsUseCase(w).execute({ page: PAGE }));
    expect(forSupervision.items[0]!.requests[0]).toMatchObject({
      withAmounts: true,
      calculation: { computedPrice: 35_700 },
      measurement: { calculation: { computedPrice: 67_725 } },
    });
  });
});

describe('visite commune avec des mesures par demande (ADR-037)', () => {
  it('chaque demande reçoit ses mesures ; demande hors de la visite refusée sans rien enregistrer', async () => {
    const w = testWorld();
    w.catalog.services.set('home_cleaning', homeCleaning());
    w.catalog.services.set('garden_maintenance', gardenService());
    w.catalog.placeTypes.set('house', placeType({ serviceCodes: ['home_cleaning', 'garden_maintenance'] }));
    w.agents.agents.set(AGENT_ID, {
      agentId: AGENT_ID,
      displayName: 'Awa',
      active: true,
      unavailabilities: [],
    });
    const view = await asCustomer(() =>
      new RequestQuoteGroupUseCase(w).execute({
        idempotencyKey: 'grp-measure',
        placeType: 'house',
        location: { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 15 },
        landmark: 'Portail bleu',
        items: [
          { serviceCode: 'home_cleaning', ...CLIENT },
          {
            serviceCode: 'garden_maintenance',
            answers: { surface: 400, condition: 'maintained' },
            optionSelections: [],
            frequency: 'once',
          },
        ],
        preferredSlots: [SLOT],
      }),
    );
    const [home, garden] = view.requests.map((request) => request.id) as [string, string];
    const groupId = view.group.id;
    await asSupervisor(() =>
      new ScheduleGroupVisitUseCase(w).execute({ groupId, scheduledAt: VISIT_AT, agentId: AGENT_ID }),
    );
    w.clock.current = new Date('2026-10-26T10:00:00Z');
    const completeGroup = (measurements: object[]) =>
      asAgent(() =>
        new CompleteGroupVisitUseCase(w).execute({
          groupId,
          report: 'Maison et jardin vus.',
          measurements: measurements as never,
        }),
      );

    const unknown = await completeGroup([{ requestId: SUPERVISOR_ID, ...MEASURED }]).catch(
      (caught: AppError) => caught,
    );
    expect(unknown).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'measurements[0].requestId' },
    });
    const invalid = await completeGroup([
      { requestId: home, ...MEASURED },
      { requestId: garden, answers: { surface: 0, condition: 'maintained' }, frequency: 'once' },
    ]).catch((caught: AppError) => caught);
    expect(invalid).toMatchObject({
      details: { field: 'measurements[1].answers.surface', reason: 'out_of_range' },
    });
    expect(w.requests.requests.get(home)!.visit?.status).toBe('scheduled');

    const outcome = await completeGroup([
      {
        requestId: garden,
        answers: { surface: 600, condition: 'overgrown' },
        optionSelections: [],
        frequency: 'once',
      },
    ]);
    expect(outcome.affectedIds.sort()).toEqual([home, garden].sort());
    expect(w.requests.requests.get(home)!.measurement ?? null).toBeNull();
    expect(w.requests.requests.get(garden)!.measurement).toMatchObject({
      answers: { surface: 600, condition: 'overgrown' },
      measuredBy: AGENT_ID,
      calculation: { priced: true },
    });
    const audit = w.recorder.changes.at(-1)!.audit.map((entry) => [entry.action, entry.entityId]);
    expect(audit).toEqual(
      expect.arrayContaining([
        ['visit.completed', home],
        ['visit.completed', garden],
        ['request.measured', garden],
      ]),
    );

    // Réponse du compte rendu commun (groupe relu) : sans montants pour l'agent, complète pour la supervision.
    const seenByAgent = await asAgent(() => new GetRequestGroupUseCase(w).execute(groupId));
    expect(seenByAgent.requests.map((request) => [request.withAmounts, request.calculation])).toEqual([
      [false, null],
      [false, null],
    ]);
    expect(seenByAgent.requests.find((request) => request.id === garden)!.measurement).toMatchObject({
      answers: { surface: 600, condition: 'overgrown' },
    });
    const seenBySupervision = await asSupervisor(() => new GetRequestGroupUseCase(w).execute(groupId));
    expect(seenBySupervision.requests.every((request) => request.withAmounts && request.calculation)).toBe(
      true,
    );

    // Envoi groupé : le jardin est prérempli depuis ses mesures (600 m² × 150 × 1,3).
    w.clock.current = new Date('2026-10-23T08:00:00Z');
    await asSupervisor(() =>
      new SendGroupQuotesUseCase(w).execute({
        groupId,
        proposedSlots: [SLOT],
        validityDays: 0,
        quotes: [{ requestId: garden, lines: [], teamSize: 0, durationMinutes: 120 }],
      }),
    );
    expect(w.requests.requests.get(garden)!.quote?.lines[0]).toMatchObject({ quantity: 600 });
  });
});
