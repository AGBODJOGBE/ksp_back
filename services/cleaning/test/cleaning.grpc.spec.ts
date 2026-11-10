import { type AddressInfo, createServer } from 'node:net';
import { cleaningV1, commonV1 } from '@ksp/contracts';
import {
  AppError,
  GrpcCaller,
  grpcClientOptions,
  GrpcContextInterceptor,
  GrpcExceptionFilter,
  grpcServerOptions,
  runWithContext,
} from '@ksp/platform';
import { type INestMicroservice, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type ClientGrpc, ClientProxyFactory, type MicroserviceOptions } from '@nestjs/microservices';
import { type Metadata } from '@grpc/grpc-js';
import { type Observable } from 'rxjs';
import { newPaymentState } from '../src/domain/payment';
import { homeCleaning, testWorld, type TestWorld } from '../src/application/testing/fakes';
import { CLEANING_USE_CASES, createUseCases } from '../src/application/use-cases';
import { CleaningAdminGrpcController } from '../src/interfaces/grpc/admin.controller';
import {
  CatalogGrpcController,
  MissionGrpcController,
  ObligationGrpcController,
  QuoteGrpcController,
} from '../src/interfaces/grpc/customer.controllers';

/**
 * Bout en bout sur un vrai serveur gRPC (doublures en mémoire, sans base) : chargement des deux
 * paquets (cleaning et ksp.common.v1), traduction des messages, contexte utilisateur transmis
 * dans les métadonnées comme le fait la gateway, et traduction des erreurs.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const CUSTOMER = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e11';
const SLOT = { start: '2026-12-30T08:00:00.000Z', end: '2026-12-30T11:00:00.000Z' };

describe('cleaning en gRPC', () => {
  let app: INestMicroservice;
  let world: TestWorld;
  let catalog: cleaningV1.CatalogServiceClient;
  let quotes: cleaningV1.QuoteServiceClient;
  let admin: cleaningV1.CleaningAdminServiceClient;
  let obligations: commonV1.ObligationServiceClient;
  const caller = new GrpcCaller({ target: 'cleaning' });

  beforeAll(async () => {
    world = testWorld();
    world.clock.current = new Date('2026-12-01T08:00:00Z');
    world.catalog.services.set('home_cleaning', homeCleaning());

    @Module({
      controllers: [
        CatalogGrpcController,
        QuoteGrpcController,
        MissionGrpcController,
        CleaningAdminGrpcController,
        ObligationGrpcController,
      ],
      providers: [{ provide: CLEANING_USE_CASES, useValue: createUseCases(world) }, GrpcContextInterceptor],
    })
    class TestModule {}

    const port = await freePort();
    app = await NestFactory.createMicroservice<MicroserviceOptions>(TestModule, {
      ...grpcServerOptions(['cleaning', 'obligation'], port),
      logger: false,
    });
    app.useGlobalFilters(new GrpcExceptionFilter());
    app.useGlobalInterceptors(app.get(GrpcContextInterceptor));
    await app.listen();

    const url = `127.0.0.1:${port}`;
    const client = (pkg: 'cleaning' | 'obligation') =>
      ClientProxyFactory.create(grpcClientOptions('c', pkg, url) as never) as unknown as ClientGrpc;
    catalog = client('cleaning').getService(cleaningV1.CATALOG_SERVICE_NAME);
    quotes = client('cleaning').getService(cleaningV1.QUOTE_SERVICE_NAME);
    admin = client('cleaning').getService(cleaningV1.CLEANING_ADMIN_SERVICE_NAME);
    obligations = client('obligation').getService(commonV1.OBLIGATION_SERVICE_NAME);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** Appel au nom d'un utilisateur : le contexte part dans les métadonnées (x-user-id, x-user-roles…). */
  const call = <T>(
    invoke: (metadata: Metadata) => Observable<T>,
    user?: { userId: string; roles: string[]; mfa?: boolean },
  ): Promise<T> =>
    runWithContext(
      {
        correlationId: '0192f1c4-0000-7000-8000-00000000c0de',
        ...(user
          ? {
              user: {
                userId: user.userId,
                sessionId: 's',
                activeContext: 'personal',
                roles: user.roles.map((role) => ({ role, scopeType: 'global' as const })),
                mfa: user.mfa ?? false,
                authTime: Math.floor(Date.now() / 1000),
              },
            }
          : {}),
      },
      () => caller.call('test', invoke),
    );
  const asCustomer = { userId: CUSTOMER, roles: ['customer'] };

  /** Réponses au formulaire du nettoyage à domicile (ADR-033). */
  const ANSWERS: cleaningV1.AnswerSet = {
    values: {
      housing_type: { choiceValue: 'apartment' },
      rooms: { numberValue: 6 },
      bathrooms: { numberValue: 1 },
      condition: { choiceValue: 'normal' },
      pets: { booleanValue: false },
    },
  };
  const WINDOWS = [{ code: 'windows', answers: { values: { window_count: { numberValue: 8 } } } }];

  it('catalogue public : formulaire sans prix, anciens champs remplis', async () => {
    const { services } = await call((m) => catalog.listServices({}, m));
    expect(services[0]).toMatchObject({
      code: 'home_cleaning',
      unit: 'room',
      priced: true,
      minimumPrice: { amount: 15000, currency: 'XOF' },
      options: [
        { code: 'windows', label: 'Vitres' },
        { code: 'sofa', label: 'Canapé' },
        { code: 'appliances', label: 'Électroménager', price: { amount: 5000, currency: 'XOF' } },
      ],
    });
    const form = services[0]!.form!;
    expect(form.fields.map((field) => [field.code, field.type, field.unitLabel])).toEqual([
      ['housing_type', 'choice', ''],
      ['rooms', 'number', 'pièces'],
      ['bathrooms', 'number', 'salles de bain'],
      ['condition', 'choice', ''],
      ['pets', 'boolean', ''],
    ]);
    expect(form.fields[1]).toEqual({
      code: 'rooms',
      label: 'Nombre de pièces',
      type: 'number',
      required: true,
      helpText: '',
      unitLabel: 'pièces',
      min: 1,
      max: 50,
      choices: [],
    });
    expect(form.options[0]!.fields[0]!.code).toBe('window_count');
    expect(form.frequencies.map((frequency) => frequency.code)).toEqual(['once', 'weekly', 'monthly']);
    // Aucun montant dans le formulaire public.
    expect(JSON.stringify(form)).not.toMatch(/amount|supplement|coefficient|price/i);
  });

  it('simulateur : nouveau format, détail du calcul ; ancien format toléré', async () => {
    const simulation = await call((m) =>
      catalog.simulate(
        {
          serviceCode: 'home_cleaning',
          premisesType: '',
          quantity: 0,
          options: [],
          answers: ANSWERS,
          optionSelections: WINDOWS,
          commune: 'Abomey-Calavi',
          frequency: 'once',
        },
        m,
      ),
    );
    expect(simulation).toMatchObject({
      covered: true,
      priced: true,
      reason: '',
      estimate: { low: { amount: 32000, currency: 'XOF' }, high: { amount: 41000, currency: 'XOF' } },
      computedPrice: { amount: 35700, currency: 'XOF' },
      communeCoefficientBp: 10500,
      recommendedTeamSize: 2,
    });
    expect(simulation.breakdown).toHaveLength(3);
    expect(simulation.calculation).toMatchObject({
      pricingVersion: 3,
      priced: true,
      baseAmount: { amount: 34000, currency: 'XOF' },
      subtotal: { amount: 35700, currency: 'XOF' },
    });
    expect(simulation.calculation!.lines[2]).toMatchObject({
      kind: 'unit_price',
      optionCode: 'windows',
      fieldCode: 'window_count',
      choiceCode: '',
      quantity: 8,
    });

    const legacy = await call((m) =>
      catalog.simulate(
        {
          serviceCode: 'home_cleaning',
          premisesType: 'house',
          quantity: 6,
          options: ['windows'],
          optionSelections: [],
          commune: 'Abomey-Calavi',
          frequency: 'once',
        },
        m,
      ),
    );
    expect(legacy).toMatchObject({ priced: false, reason: 'answers_incomplete', breakdown: [] });
  });

  it('plan de passages : aperçu des dates, simulation au nombre exact de passages (ADR-052)', async () => {
    const schedule: cleaningV1.InterventionSchedule = {
      mode: 'monthly',
      dates: [],
      startDate: '2027-01-01',
      endDate: '2027-03-31',
      weekdays: ['mon'],
      everyWeeks: 0,
      monthDays: [],
      weeksOfMonth: ['1', '3'],
      startTime: '08:00',
      excludedDates: ['2027-02-15'],
      extraDates: [],
    };
    const preview = await call((m) => catalog.previewSchedule({ schedule }, m));
    expect(preview.preview).toEqual({
      dates: ['2027-01-04', '2027-01-18', '2027-02-01', '2027-03-01', '2027-03-15'],
      count: 5,
      firstDate: '2027-01-04',
      lastDate: '2027-03-15',
      warnings: [{ code: 'excluded', date: '2027-02-15', message: expect.any(String) }],
    });
    const simulation = await call((m) =>
      catalog.simulate(
        {
          serviceCode: 'home_cleaning',
          premisesType: '',
          quantity: 0,
          options: [],
          answers: ANSWERS,
          optionSelections: WINDOWS,
          commune: 'Abomey-Calavi',
          frequency: 'once',
          schedule,
        },
        m,
      ),
    );
    expect(simulation).toMatchObject({
      computedPrice: { amount: 35700, currency: 'XOF' },
      schedule: { count: 5 },
      scheduleTotal: { amount: 178500, currency: 'XOF' },
      scheduleEstimate: { low: { amount: 160000 }, high: { amount: 205000 } },
    });
    const refused = await call((m) =>
      catalog.previewSchedule({ schedule: { ...schedule, weeksOfMonth: ['5'] } }, m),
    ).catch((error: AppError) => error);
    expect(refused).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'schedule.weeksOfMonth' },
    });
  });

  it('zones desservies publiques : actives seulement, code et nom, sans utilisateur', async () => {
    const calavi = world.catalog.zones.get('abomey-calavi')!;
    world.catalog.zones.set('abomey-calavi', { ...calavi, active: false });
    try {
      const { zones } = await call((m) => catalog.listServedZones({}, m));
      expect(zones).toEqual([
        { code: 'cotonou', commune: 'Cotonou' },
        { code: 'porto-novo', commune: 'Porto-Novo' },
      ]);
    } finally {
      world.catalog.zones.set('abomey-calavi', calavi);
    }
  });

  it('demande de devis au nom du client transmis par la gateway', async () => {
    const { request } = await call(
      (m) =>
        quotes.requestQuote(
          {
            idempotencyKey: 'grpc-1',
            serviceCode: 'home_cleaning',
            premisesType: '',
            quantity: 0,
            options: [],
            answers: ANSWERS,
            optionSelections: WINDOWS,
            frequency: 'once',
            commune: 'Cotonou',
            address: 'Lot 12',
            preferredSlots: [SLOT],
            comment: '',
            requestedTeamSize: 0,
            daysPerWeek: 0,
          },
          m,
        ),
      asCustomer,
    );
    expect(request).toMatchObject({
      status: 'received',
      customerId: CUSTOMER,
      organizationId: '',
      missionId: '',
    });
    expect(request?.preferredSlots).toEqual([SLOT]);
    expect(request).toMatchObject({
      answers: ANSWERS,
      optionSelections: WINDOWS,
      frequency: 'once',
      pricingVersion: 3,
      premisesType: 'other',
      quantity: 6,
      options: ['windows'],
      calculation: { priced: true, computedPrice: { amount: 34000, currency: 'XOF' } },
    });
    // Suppression du compte (ADR-036) : la demande ouverte la bloque.
    const pending = await call((m) =>
      obligations.hasPendingObligations({ userId: CUSTOMER, organizationId: '' }, m),
    );
    expect(pending).toEqual({
      hasPending: true,
      obligations: [
        {
          kind: 'open_cleaning_request',
          reference: request?.id,
          description: 'Une demande de devis de nettoyage est en cours.',
        },
      ],
    });
    const other = await call((m) =>
      obligations.hasPendingObligations(
        { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001', organizationId: '' },
        m,
      ),
    );
    expect(other).toEqual({ hasPending: false, obligations: [] });
  });

  it('back-office : super_admin, filtres de zone et de type, noms lus dans l’annuaire', async () => {
    world.people.users.set(CUSTOMER, 'Koffi Adjovi');
    const superAdmin = { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0009', roles: ['super_admin'], mfa: true };
    const list = (commune: string, customerKind: string) =>
      call(
        (m) =>
          admin.listQuoteRequests(
            {
              page: { limit: 10, cursor: '' },
              status: '',
              commune,
              customerKind,
              groupId: '',
              placeType: '',
              serviceCode: '',
            },
            m,
          ),
        superAdmin,
      );
    const { requests } = await list('cotonou', 'individual');
    expect(requests.map((r) => [r.commune, r.customerName, r.organizationName])).toEqual([
      ['Cotonou', 'Koffi Adjovi', ''],
    ]);
    expect((await list('cotonou', 'business')).requests).toEqual([]);
    expect((await list('porto-novo', '')).requests).toEqual([]);
  });

  it('back-office : type de client sur la mission, reste dû dans l’erreur de paiement', async () => {
    const organizationId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000';
    world.people.organizations.set(organizationId, 'SARL Bénin Propre');
    const base = {
      requestId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d2000',
      quoteId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d3000',
      customerId: CUSTOMER,
      status: 'to_schedule' as const,
      serviceCode: 'home_cleaning',
      commune: 'Cotonou',
      address: 'Lot 12',
      location: null,
      landmark: null,
      groupId: null,
      placeType: null,
      chosenSlot: { start: new Date(SLOT.start), end: new Date(SLOT.end) },
      recurrence: null,
      plannedInterventions: 1,
      interventions: [],
      payment: newPaymentState({ option: 'full', timing: 'after', method: 'cash' }, 30_000, 30),
      cancellationReason: null,
      daysPerWeek: null,
      suspension: null,
      warningLevel: 0,
      createdAt: new Date('2026-12-01T08:00:00Z'),
      updatedAt: new Date('2026-12-01T08:00:00Z'),
      version: 0,
    };
    const businessId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1b00';
    const individualId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1a00';
    world.missions.missions.set(businessId, { ...base, id: businessId, organizationId });
    world.missions.missions.set(individualId, { ...base, id: individualId, organizationId: null });
    const supervisor = {
      userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001',
      roles: ['cleaning_supervisor'],
      mfa: true,
    };

    const { mission } = await call((m) => admin.getMissionDetail({ missionId: businessId }, m), supervisor);
    expect(mission).toMatchObject({
      customerKind: 'business',
      organizationId,
      customerName: 'Koffi Adjovi',
      organizationName: 'SARL Bénin Propre',
    });

    const pay = (amount: number, idempotencyKey: string) =>
      call(
        (m) =>
          admin.recordPayment(
            {
              missionId: individualId,
              amount: { amount, currency: 'XOF' },
              method: 'cash',
              reference: '',
              idempotencyKey,
            },
            m,
          ),
        supervisor,
      );
    const first = await pay(10_000, 'grpc-paiement-1');
    expect(first.mission?.customerKind).toBe('individual');
    expect((await pay(10_000, 'grpc-paiement-1')).mission?.payment?.payments).toHaveLength(1);
    const refused = await pay(25_000, 'grpc-paiement-2').catch((error: AppError) => error);
    expect(refused).toMatchObject({
      code: 'CLEANING_PAYMENT_INVALID',
      details: { reason: 'exceeds_balance', remainingDue: { amount: 20_000, currency: 'XOF' } },
    });
  });

  it('traduit les erreurs : non connecté, introuvable, droits du back-office', async () => {
    const reason = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: AppError) => [error.kind, error.code],
      );
    expect(await reason(call((m) => quotes.listMyRequests({}, m)))).toEqual([
      'UNAUTHENTICATED',
      'AUTH_REQUIRED',
    ]);
    expect(
      await reason(
        call((m) => quotes.getRequest({ requestId: '0192f1c4-0000-7000-8000-000000000999' }, m), asCustomer),
      ),
    ).toEqual(['NOT_FOUND', 'CLEANING_REQUEST_NOT_FOUND']);
    expect(await reason(call((m) => admin.getCatalog({}, m), asCustomer))).toEqual([
      'PERMISSION_DENIED',
      'AUTH_FORBIDDEN',
    ]);
    expect(
      await reason(
        call((m) => admin.getCatalog({}, m), { userId: CUSTOMER, roles: ['cleaning_admin'], mfa: false }),
      ),
    ).toEqual(['PERMISSION_DENIED', 'AUTH_MFA_REQUIRED']);
    const { services } = await call((m) => admin.getCatalog({}, m), {
      userId: CUSTOMER,
      roles: ['cleaning_admin'],
      mfa: true,
    });
    expect(services[0]?.pricing?.unitPrice).toEqual({ amount: 4500, currency: 'XOF' });
  });

  it('back-office : définition complète enregistrée telle quelle, essai d’une grille', async () => {
    const adminUser = { userId: CUSTOMER, roles: ['cleaning_admin'], mfa: true };
    const { services } = await call((m) => admin.getCatalog({}, m), adminUser);
    const current = services.find((service) => service.code === 'home_cleaning')!;
    expect(current.fields[3]!.choices[1]).toEqual({
      code: 'dirty',
      label: 'Sale',
      // Prix non fixé : message absent (null une fois décodé).
      supplement: null,
      coefficientBp: 12000,
      active: true,
    });
    expect(current.pricing!.teamSize).toEqual({
      fieldCode: 'rooms',
      unitsPerAgent: 3,
      minAgents: 1,
      maxAgents: 6,
    });

    const { service: saved } = await call(
      (m) => admin.saveService({ service: { ...current, code: 'home_cleaning_copy' } }, m),
      adminUser,
    );
    expect(saved!.fields).toEqual(current.fields);
    expect(saved!.options).toEqual(current.options);
    expect(saved!.pricing).toMatchObject({
      version: 1,
      frequencies: current.pricing!.frequencies,
      minimumPrice: { amount: 15000, currency: 'XOF' },
    });

    const preview = await call(
      (m) =>
        admin.previewService(
          {
            serviceCode: 'garden_maintenance',
            definition: { ...current, fields: current.fields.map((field) => ({ ...field })) },
            answers: ANSWERS,
            optionSelections: [],
            commune: 'Cotonou',
            frequency: 'weekly',
            requestedTeamSize: 0,
          },
          m,
        ),
      adminUser,
    );
    // (27 000 + 3 000) × 0,9 ; définition essayée : pas de version.
    expect(preview).toMatchObject({
      serviceCode: 'garden_maintenance',
      covered: true,
      calculation: { pricingVersion: 0, priced: true, computedPrice: { amount: 27000, currency: 'XOF' } },
    });
    expect(world.catalog.services.has('garden_maintenance')).toBe(false);

    const refused = await call(
      (m) => admin.saveService({ service: { ...current, code: 'legacy_body', fields: [], options: [] } }, m),
      adminUser,
    ).then(
      () => null,
      (error: AppError) => [error.code, error.details],
    );
    expect(refused).toEqual(['CLEANING_VALIDATION_FAILED', { field: 'fields', reason: 'required' }]);
  });

  it('parcours par lieu : catalogue, estimation, position, groupe, demandes sœurs (ADR-034)', async () => {
    world.catalog.placeTypes.set('house', {
      code: 'house',
      label: 'Maison',
      description: '',
      icon: 'house',
      displayOrder: 10,
      active: true,
      serviceCodes: ['home_cleaning', 'missing_service'],
      updatedBy: null,
      updatedAt: null,
    });
    const place = await call((m) => catalog.getPlaceCatalog({}, m));
    expect(place.placeTypes).toEqual([
      expect.objectContaining({ code: 'house', serviceCodes: ['home_cleaning'], displayOrder: 10 }),
    ]);
    expect(place.services.map((service) => service.code)).toEqual(['home_cleaning']);

    const item = {
      serviceCode: 'home_cleaning',
      answers: ANSWERS,
      optionSelections: WINDOWS,
      frequency: 'once',
    };
    const estimate = await call((m) =>
      catalog.estimate({ placeType: 'house', commune: '', items: [item] }, m),
    );
    expect(estimate).toMatchObject({
      placeType: 'house',
      commune: '',
      communeApplied: false,
      status: 'priced',
      total: { amount: 34000, currency: 'XOF' },
      items: [{ serviceCode: 'home_cleaning', serviceName: 'Nettoyage à domicile', priced: true }],
    });

    const resolved = await call(
      (m) => quotes.resolveLocation({ latitude: 6.4489, longitude: 2.3556 }, m),
      asCustomer,
    );
    expect(resolved).toMatchObject({
      commune: 'Abomey-Calavi',
      zoneCode: 'abomey-calavi',
      served: true,
      provider: 'nominatim',
    });

    const { group } = await call(
      (m) =>
        quotes.requestQuoteGroup(
          {
            idempotencyKey: 'grpc-group-1',
            placeType: 'house',
            location: { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 0 },
            landmark: 'Portail bleu',
            commune: '',
            items: [{ ...item, requestedTeamSize: 0 }],
            preferredSlots: [SLOT],
            comment: '',
          },
          m,
        ),
      asCustomer,
    );
    expect(group).toMatchObject({ placeType: 'house', commune: 'Abomey-Calavi', zoneCode: 'abomey-calavi' });
    expect(group?.requests[0]).toMatchObject({
      groupId: group?.id,
      placeType: 'house',
      landmark: 'Portail bleu',
      geocodingProvider: 'nominatim',
      geocodedAddress: 'Zogbadjè, Abomey-Calavi, Atlantique, Bénin',
      groupSize: 1,
      serviceName: 'Nettoyage à domicile',
      placeTypeLabel: 'Maison',
      location: { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 0 },
    });
    const again = await call((m) => quotes.getRequestGroup({ groupId: group!.id }, m), asCustomer);
    expect(again.group?.requests.map((r) => r.id)).toEqual(group?.requests.map((r) => r.id));

    const staff = { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001', roles: ['cleaning_admin'], mfa: true };
    const detail = await call((m) => admin.getQuoteRequest({ requestId: group!.requests[0]!.id }, m), staff);
    expect(detail.groupRequests).toEqual([]);
    const { placeTypes } = await call((m) => admin.listPlaceTypes({}, m), staff);
    expect(placeTypes[0]).toMatchObject({
      code: 'house',
      unknownServiceCodes: ['missing_service'],
      publiclyVisible: true,
      visibilityReason: '',
    });
    const saved = await call(
      (m) =>
        admin.savePlaceType(
          {
            placeType: {
              code: 'office',
              label: 'Bureau',
              description: '',
              icon: 'office',
              displayOrder: 40,
              active: false,
              serviceCodes: ['home_cleaning'],
              updatedBy: '',
              updatedAt: '',
              updatedByName: '',
              unknownServiceCodes: [],
              inactiveServiceCodes: [],
              publiclyVisible: true,
              visibilityReason: '',
            },
          },
          m,
        ),
      staff,
    );
    expect(saved.placeType).toMatchObject({
      code: 'office',
      publiclyVisible: false,
      visibilityReason: 'inactive',
    });
  });

  it('mesures constatées : compte rendu, recalcul, correction, réponses lisibles (ADR-037)', async () => {
    const AGENT = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002';
    world.agents.agents.set(AGENT, {
      agentId: AGENT,
      displayName: 'Awa',
      active: true,
      unavailabilities: [],
    });
    const staff = {
      userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001',
      roles: ['cleaning_supervisor'],
      mfa: true,
    };
    const agent = { userId: AGENT, roles: ['cleaning_agent'], mfa: true };
    const { request } = await call(
      (m) =>
        quotes.requestQuote(
          {
            idempotencyKey: 'grpc-measure',
            serviceCode: 'home_cleaning',
            premisesType: '',
            quantity: 0,
            options: [],
            answers: ANSWERS,
            optionSelections: WINDOWS,
            frequency: 'once',
            commune: 'Cotonou',
            address: 'Lot 12',
            preferredSlots: [SLOT],
            comment: '',
            requestedTeamSize: 0,
            daysPerWeek: 0,
          },
          m,
        ),
      asCustomer,
    );
    const requestId = request!.id;
    const scheduled = await call(
      (m) => admin.scheduleVisit({ requestId, scheduledAt: '2026-12-02T09:00:00Z', agentId: AGENT }, m),
      staff,
    );
    const measured: cleaningV1.AnswerSet = {
      values: { ...ANSWERS.values, rooms: { numberValue: 8 } },
    };
    const before = world.clock.current;
    world.clock.current = new Date('2026-12-02T10:00:00Z');
    const done = await call(
      (m) =>
        admin.completeVisit(
          {
            visitId: scheduled.request!.visit!.id,
            report: 'Huit pièces.',
            measurements: { answers: measured, optionSelections: WINDOWS, frequency: 'once' },
          },
          m,
        ),
      agent,
    );
    world.clock.current = before;
    expect(done.request?.measurement).toMatchObject({
      answers: measured,
      frequency: 'once',
      pricingVersion: 3,
      measuredBy: AGENT,
      measuredByName: 'Awa',
    });
    // Agent seul : aucun montant dans la réponse du compte rendu (ADR-037), le recalcul reste ouvert.
    expect(done.request?.measurement?.calculation ?? null).toBeNull();
    expect(done.request?.calculation ?? null).toBeNull();
    expect(done.request?.estimate ?? null).toBeNull();
    expect(world.requests.requests.get(requestId)!.measurement?.calculation).toMatchObject({
      priced: true,
      computedPrice: 43000,
    });
    expect(done.request?.measuredSummary?.fields[1]).toMatchObject({
      code: 'rooms',
      label: 'Nombre de pièces',
      type: 'number',
      value: { numberValue: 8 },
      display: '8 pièces',
      unitLabel: 'pièces',
    });

    const estimate = await call(
      (m) =>
        admin.estimateRequestPrice(
          { requestId, answers: ANSWERS, optionSelections: [], frequency: 'once' },
          m,
        ),
      agent,
    );
    expect(estimate).toMatchObject({
      requestId,
      serviceCode: 'home_cleaning',
      commune: 'Cotonou',
      calculation: { priced: true, computedPrice: { amount: 30000, currency: 'XOF' } },
    });
    const refused = await call(
      (m) => admin.saveRequestMeasurements({ requestId, optionSelections: [], frequency: 'once' }, m),
      staff,
    ).catch((error: AppError) => error);
    expect(refused).toMatchObject({ code: 'CLEANING_VALIDATION_FAILED', details: { field: 'answers' } });
    const corrected = await call(
      (m) =>
        admin.saveRequestMeasurements(
          { requestId, answers: ANSWERS, optionSelections: [], frequency: 'once' },
          m,
        ),
      staff,
    );
    expect(corrected.request?.measurement?.calculation?.computedPrice).toEqual({
      amount: 30000,
      currency: 'XOF',
    });
    // Le chargeur gRPC ajoute le nom du choix de oneof (« value ») : comparaison partielle.
    expect(corrected.request?.answerSummary?.options).toMatchObject([
      {
        optionCode: 'windows',
        label: 'Vitres',
        fields: [
          {
            code: 'window_count',
            label: 'Nombre de fenêtres',
            type: 'number',
            value: { numberValue: 8 },
            display: '8 fenêtres',
            unitLabel: 'fenêtres',
          },
        ],
      },
    ]);
    expect(corrected.request?.answerSummary?.frequency).toEqual({ code: 'once', label: 'Une fois' });

    // Liste des visites : réponses du client et mesures pour préremplir la saisie ; montants à la
    // supervision seulement.
    const listVisits = (user: typeof staff) =>
      call(
        (m) =>
          admin.listVisits(
            { page: { limit: 10, cursor: '' }, agentId: '', from: '', to: '', status: '', groupId: '' },
            m,
          ),
        user,
      );
    const forAgent = (await listVisits(agent)).visits.flatMap((visit) => visit.requests);
    expect(forAgent).toHaveLength(1);
    expect(forAgent[0]).toMatchObject({
      requestId,
      serviceCode: 'home_cleaning',
      serviceName: 'Nettoyage à domicile',
      answers: ANSWERS,
      frequency: 'once',
      pricingVersion: 3,
      measurement: { answers: ANSWERS, frequency: 'once', measuredBy: staff.userId },
    });
    expect(forAgent[0]?.optionSelections.map((option) => option.code)).toEqual(['windows']);
    expect(forAgent[0]?.answerSummary?.fields[1]?.display).toBe('6 pièces');
    expect(forAgent[0]?.measuredSummary?.fields[1]?.display).toBe('6 pièces');
    expect(forAgent[0]?.calculation ?? null).toBeNull();
    expect(forAgent[0]?.measurement?.calculation ?? null).toBeNull();
    const forSupervision = (await listVisits(staff)).visits.flatMap((visit) => visit.requests);
    expect(forSupervision[0]?.calculation).toMatchObject({ priced: true });
    expect(forSupervision[0]?.measurement?.calculation?.computedPrice).toEqual({
      amount: 30000,
      currency: 'XOF',
    });

    // Correction des mesures par l'agent : réponse sans montant.
    const byAgent = await call(
      (m) =>
        admin.saveRequestMeasurements(
          { requestId, answers: ANSWERS, optionSelections: [], frequency: 'once' },
          m,
        ),
      agent,
    );
    expect(byAgent.request?.measurement).toMatchObject({ measuredBy: AGENT });
    expect(byAgent.request?.measurement?.calculation ?? null).toBeNull();
    expect(byAgent.request?.calculation ?? null).toBeNull();

    // Espace client : réponses lisibles, jamais les mesures.
    const mine = await call((m) => quotes.getRequest({ requestId }, m), asCustomer);
    expect(mine.request?.answerSummary?.fields.map((field) => field.display)).toEqual([
      'Appartement',
      '6 pièces',
      '1 salles de bain',
      'Normal',
      'Non',
    ]);
    expect(mine.request?.measurement ?? null).toBeNull();
    expect(mine.request?.measuredSummary ?? null).toBeNull();
  });
});
