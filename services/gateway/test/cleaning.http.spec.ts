import { AppError } from '@ksp/platform';
import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  type CleaningServer,
  IDS,
  protoMission,
  protoRequest,
  protoVisit,
  startCleaningStub,
  stubDefault,
} from './support/cleaning-stub';
import {
  type IdentityServer,
  ORIGINS,
  protoIndividual,
  protoUser,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à cleaning : utilisateur et rôles dans le contexte, clé
 * d'idempotence, montants convertis en { amount, currency }, profil vérifié avant une demande.
 */
describe('gateway → cleaning', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let cleaning: CleaningServer;
  let app: NestExpressApplication;
  let customer: string;
  let staff: string;
  let admin: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    cleaning = await startCleaningStub(keys);
    app = await startGateway({
      identityUrl: identity.url,
      cleaningUrl: cleaning.url,
      keys,
      // Simulations et aperçus de plans partagent la limite publique (20 par minute) : relevée ici,
      // la limite elle-même est testée ailleurs.
      env: { RATE_LIMIT_CLEANING_SIMULATION_PER_MINUTE: '1000' },
    });
    customer = await keys.accessToken();
    staff = await keys.accessToken({
      claims: {
        client_id: 'backoffice',
        mfa: true,
        roles: [{ role: 'cleaning_supervisor', scopeType: 'global' }],
      },
    });
    admin = await keys.accessToken({
      claims: {
        client_id: 'backoffice',
        mfa: true,
        roles: [{ role: 'cleaning_admin', scopeType: 'global' }],
      },
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await identity?.close();
    await cleaning?.close();
  });

  beforeEach(() => {
    identity.stub.reset();
    cleaning.stub.reset();
    identity.stub.on('getMe', async () => ({
      user: protoUser,
      profileIncomplete: false,
      activeContext: protoIndividual,
    }));
  });

  const http = () => request(app.getHttpServer());
  const xof = (amount: number) => ({ amount, currency: 'XOF' });
  const QUOTE_BODY = {
    serviceCode: 'home_cleaning',
    premisesType: 'house',
    quantity: 6,
    commune: 'Cotonou',
    address: 'Lot 12',
    preferredSlots: [{ start: '2026-11-05T08:00:00Z', end: '2026-11-05T11:00:00Z' }],
  };

  it('demande de devis : profil vérifié, clé d’idempotence et utilisateur transmis', async () => {
    const res = await http()
      .post('/api/v1/cleaning/quote-requests')
      .set('Origin', ORIGINS.web)
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'demande-0001')
      .send(QUOTE_BODY);
    expect(res.status).toBe(200);
    expect(identity.stub.last('getMe')).toBeDefined();
    const call = cleaning.stub.last('requestQuote')!;
    expect(call.request).toMatchObject({
      idempotencyKey: 'demande-0001',
      options: [],
      comment: '',
      requestedTeamSize: 0,
    });
    expect(call.context?.user?.userId).toBe(USER_ID);
    expect(call.context?.callerService).toBe('gateway');
  });

  it('profil incomplet : rien n’est transmis à cleaning', async () => {
    identity.stub.on('getMe', async () => ({
      user: protoUser,
      profileIncomplete: true,
      activeContext: protoIndividual,
    }));
    const res = await http()
      .post('/api/v1/cleaning/quote-requests')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'demande-0002')
      .send(QUOTE_BODY);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDENTITY_PROFILE_INCOMPLETE');
    expect(cleaning.stub.last('requestQuote')).toBeUndefined();
  });

  it('simulateur public : aucun jeton, aucun utilisateur transmis', async () => {
    const res = await http()
      .post('/api/v1/cleaning/simulations')
      .send({ serviceCode: 'home_cleaning', premisesType: 'house', quantity: 6, commune: 'Cotonou' });
    expect(res.status).toBe(200);
    expect(res.body.estimate.low).toEqual({ amount: 33500, currency: 'XOF' });
    expect(cleaning.stub.last('simulate')!.context?.user).toBeUndefined();
  });

  it('zones desservies publiques : aucun jeton, code et nom seulement', async () => {
    const res = await http().get('/api/v1/cleaning/zones');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [
        { code: 'abomey-calavi', commune: 'Abomey-Calavi' },
        { code: 'cotonou', commune: 'Cotonou' },
      ],
    });
    expect(cleaning.stub.last('listServedZones')!.context?.user).toBeUndefined();
  });

  it('acceptation : plan de paiement transmis s’il est fourni, facultatif sinon (entreprise)', async () => {
    const accept = (body: object, key: string) =>
      http()
        .post(`/api/v1/cleaning/quote-requests/${IDS.request}/accept`)
        .set('Authorization', `Bearer ${customer}`)
        .set('Idempotency-Key', key)
        .send(body);
    const plan = { option: 'deposit', timing: 'before', method: 'cash' };
    const withPlan = await accept({ slotStart: '2026-11-05T08:00:00Z', paymentPlan: plan }, 'accepte-0001');
    expect(withPlan.status).toBe(200);
    expect(cleaning.stub.last('acceptQuote')!.request['paymentPlan']).toEqual(plan);

    const withoutPlan = await accept({ slotStart: '2026-11-05T08:00:00Z' }, 'accepte-0002');
    expect(withoutPlan.status).toBe(200);
    // Message absent sur le fil : le serveur gRPC le décode à null.
    expect(cleaning.stub.last('acceptQuote')!.request['paymentPlan']).toBeNull();

    const badPlan = await accept(
      { slotStart: '2026-11-05T08:00:00Z', paymentPlan: { ...plan, method: 'cheque' } },
      'accepte-0003',
    );
    expect(badPlan.status).toBe(400);

    // Mobile Money en ligne : moyen proposé à l'acceptation.
    const online = { ...plan, method: 'mobile_money_online' };
    const onlinePlan = await accept(
      { slotStart: '2026-11-05T08:00:00Z', paymentPlan: online },
      'accepte-0004',
    );
    expect(onlinePlan.status).toBe(200);
    expect(cleaning.stub.last('acceptQuote')!.request['paymentPlan']).toEqual(online);
  });

  it('devis : montant de chaque ligne calculé, rôles transmis', async () => {
    const res = await http()
      .post(`/api/v1/admin/cleaning/quote-requests/${IDS.request}/quote`)
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`)
      .send({
        lines: [{ label: 'Bureaux', quantity: 200, unitPrice: 250 }],
        proposedSlots: [{ start: '2026-11-05T08:00:00Z', end: '2026-11-05T11:00:00Z' }],
        durationMinutes: 180,
      });
    expect(res.status).toBe(200);
    const call = cleaning.stub.last('sendQuote')!;
    expect(call.request['lines']).toEqual([
      {
        label: 'Bureaux',
        quantity: 200,
        unitPrice: { amount: 250, currency: 'XOF' },
        amount: { amount: 50000, currency: 'XOF' },
      },
    ]);
    expect(call.context?.user?.roles).toEqual([
      expect.objectContaining({ role: 'cleaning_supervisor', scopeType: 'global' }),
    ]);
    expect(call.context?.user?.mfa).toBe(true);
  });

  it('pagination : curseur suivant transmis tel quel, absent → null', async () => {
    const res = await http()
      .get('/api/v1/cleaning/missions?limit=5')
      .set('Authorization', `Bearer ${customer}`);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe(IDS.mission);
    expect(cleaning.stub.last('listMyMissions')!.request['page']).toEqual({ limit: 5, cursor: '' });
    const bad = await http()
      .get('/api/v1/cleaning/missions?limit=500')
      .set('Authorization', `Bearer ${customer}`);
    expect(bad.status).toBe(400);
  });

  it('partie 10 : jours par semaine transmis, réglages d’impayés absents envoyés à 0, suspension présentée', async () => {
    const quote = await http()
      .post('/api/v1/cleaning/quote-requests')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'cle-jours-001')
      .send({ ...QUOTE_BODY, daysPerWeek: 3 });
    expect(quote.status).toBe(200);
    expect(cleaning.stub.last('requestQuote')!.request).toMatchObject({ daysPerWeek: 3 });

    const settings = await http()
      .put('/api/v1/admin/cleaning/catalog/settings')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        quoteValidityDays: 15,
        minimumLeadHours: 48,
        freeCancellationHours: 24,
        visitThresholdSquareMeters: 300,
        maxOpenRequests: 5,
        depositPercent: 30,
        businessSuspensionUnpaidInvoices: 3,
      });
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({
      businessWarningUnpaidInvoices: 1,
      individualPaymentGraceHours: 24,
    });
    expect(cleaning.stub.last('updateSettings')!.request['settings']).toMatchObject({
      businessWarningUnpaidInvoices: 0,
      businessSuspensionUnpaidInvoices: 3,
      individualSuspensionUnpaidInterventions: 0,
      individualPaymentGraceHours: 0,
    });

    const mission = await http()
      .get(`/api/v1/cleaning/missions/${IDS.mission}`)
      .set('Authorization', `Bearer ${customer}`);
    expect(mission.body).toMatchObject({
      daysPerWeek: 2,
      suspension: {
        cause: 'unpaid_invoices',
        causes: ['unpaid_invoices', 'organization_suspended'],
        since: '2026-12-15T06:00:00.000Z',
        unpaidCount: 2,
      },
    });
    expect(mission.body.interventions[0].cancellationCause).toBeNull();

    // Service cleaning antérieur à l'ADR-030 : une seule cause, la liste en est déduite.
    cleaning.stub.on('getMission', async () => ({
      mission: {
        ...protoMission,
        suspension: {
          cause: 'organization_suspended',
          since: '2026-12-15T06:00:00.000Z',
          unpaidCount: 0,
          causes: [],
        },
      },
    }));
    const single = await http()
      .get(`/api/v1/cleaning/missions/${IDS.mission}`)
      .set('Authorization', `Bearer ${customer}`);
    expect(single.body.suspension).toEqual({
      cause: 'organization_suspended',
      causes: ['organization_suspended'],
      since: '2026-12-15T06:00:00.000Z',
      unpaidCount: 0,
    });

    const zone = await http()
      .post('/api/v1/admin/cleaning/zones/abomey-calavi/deactivate')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${admin}`);
    expect(zone.status).toBe(200);
    expect(zone.body).toMatchObject({ code: 'abomey-calavi', active: false, updatedBy: null });
    expect(cleaning.stub.last('deactivateZone')!.request).toEqual({ code: 'abomey-calavi', confirm: false });
    const supervisorZone = await http()
      .get('/api/v1/admin/cleaning/zones')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`);
    expect(supervisorZone.status).toBe(403);

    const simulation = await http()
      .post('/api/v1/cleaning/simulations')
      .send({ serviceCode: 'home_cleaning', premisesType: 'house', quantity: 6, commune: 'Parakou' });
    expect(simulation.status).toBe(200);
    expect(simulation.body.covered).toBe(true);
  });

  it('back-office : super_admin admis, filtres transmis, noms et type de client présentés', async () => {
    const superAdmin = await keys.accessToken({
      claims: { client_id: 'backoffice', mfa: true, roles: [{ role: 'super_admin', scopeType: 'global' }] },
    });
    const list = await http()
      .get(
        '/api/v1/admin/cleaning/quote-requests?status=received&commune=abomey-calavi&customerKind=business',
      )
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${superAdmin}`);
    expect(list.status).toBe(200);
    expect(cleaning.stub.last('listQuoteRequests')!.request).toMatchObject({
      status: 'received',
      commune: 'abomey-calavi',
      customerKind: 'business',
    });
    expect(list.body.data[0]).toMatchObject({ customerName: 'Koffi Adjovi', organizationName: null });
    const badCommune = await http()
      .get('/api/v1/admin/cleaning/quote-requests?commune=Abomey%20Calavi')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${superAdmin}`);
    expect(badCommune.status).toBe(400);

    const mission = await http()
      .get(`/api/v1/admin/cleaning/missions/${IDS.mission}`)
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${superAdmin}`);
    expect(mission.status).toBe(200);
    expect(mission.body).toMatchObject({
      customerKind: 'business',
      organizationId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0000',
      customerName: 'Koffi Adjovi',
      organizationName: 'SARL Bénin Propre',
    });
    const zones = await http()
      .get('/api/v1/admin/cleaning/zones')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${superAdmin}`);
    expect(zones.status).toBe(200);
  });

  it('reste dû et acompte dû calculés par cleaning, côté client et back-office', async () => {
    const customerView = await http()
      .get(`/api/v1/cleaning/missions/${IDS.mission}`)
      .set('Authorization', `Bearer ${customer}`);
    expect(customerView.status).toBe(200);
    expect(customerView.body.payment).toMatchObject({
      remainingDue: { amount: 60000, currency: 'XOF' },
      depositDue: { amount: 18000, currency: 'XOF' },
    });
    const adminView = await http()
      .get(`/api/v1/admin/cleaning/missions/${IDS.mission}`)
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.payment).toMatchObject({
      remainingDue: { amount: 60000, currency: 'XOF' },
      depositDue: { amount: 18000, currency: 'XOF' },
    });

    // Acompte reçu : plus d'acompte attendu (message absent → null).
    cleaning.stub.on('getMission', async () => ({
      mission: {
        ...protoMission,
        payment: {
          ...protoMission.payment,
          status: 'deposit_received',
          paid: xof(18000),
          remainingDue: xof(42000),
          depositDue: undefined,
        },
      },
    }));
    const received = await http()
      .get(`/api/v1/cleaning/missions/${IDS.mission}`)
      .set('Authorization', `Bearer ${customer}`);
    expect(received.body.payment).toMatchObject({ remainingDue: { amount: 42000 }, depositDue: null });

    // Service cleaning antérieur : reste dû déduit du total et des paiements reçus.
    cleaning.stub.on('getMission', async () => ({
      mission: {
        ...protoMission,
        payment: {
          ...protoMission.payment,
          paid: xof(10000),
          remainingDue: undefined,
          depositDue: undefined,
        },
      },
    }));
    const legacy = await http()
      .get(`/api/v1/cleaning/missions/${IDS.mission}`)
      .set('Authorization', `Bearer ${customer}`);
    expect(legacy.body.payment).toMatchObject({
      remainingDue: { amount: 50000, currency: 'XOF' },
      depositDue: null,
    });
  });

  it('paiement manuel : Idempotency-Key transmise si présente, vide sinon', async () => {
    const pay = (key?: string) => {
      const req = http()
        .post(`/api/v1/admin/cleaning/missions/${IDS.mission}/payments`)
        .set('Origin', ORIGINS.backoffice)
        .set('Authorization', `Bearer ${staff}`);
      return (key ? req.set('Idempotency-Key', key) : req).send({ amount: 5000, method: 'cash' });
    };
    expect((await pay('paiement-cle-0001')).status).toBe(200);
    expect(cleaning.stub.last('recordPayment')!.request).toMatchObject({
      idempotencyKey: 'paiement-cle-0001',
    });
    expect((await pay()).status).toBe(200);
    expect(cleaning.stub.last('recordPayment')!.request).toMatchObject({ idempotencyKey: '' });
  });

  // --- Formulaire paramétrable (ADR-033) ------------------------------------------------------

  const ANSWERS = { housing_type: 'apartment', rooms: 6, pets: false };
  const OPTIONS = [{ code: 'windows', answers: { window_count: 8 } }];

  it('simulation au nouveau format : réponses traduites, détail du calcul présenté', async () => {
    const res = await http().post('/api/v1/cleaning/simulations').send({
      serviceCode: 'home_cleaning',
      answers: ANSWERS,
      options: OPTIONS,
      frequency: 'once',
      commune: 'Cotonou',
    });
    expect(res.status).toBe(200);
    expect(cleaning.stub.last('simulate')!.request).toMatchObject({
      answers: {
        values: {
          housing_type: { choiceValue: 'apartment' },
          rooms: { numberValue: 6 },
          pets: { booleanValue: false },
        },
      },
      optionSelections: [{ code: 'windows', answers: { values: { window_count: { numberValue: 8 } } } }],
      premisesType: '',
      quantity: 0,
      options: [],
      frequency: 'once',
    });
    expect(res.body).toMatchObject({ reason: null, calculation: { pricingVersion: 3, priced: true } });
    expect(res.body.calculation.lines[1]).toEqual({
      kind: 'unit_price',
      optionCode: 'windows',
      fieldCode: 'window_count',
      choiceCode: null,
      label: 'Vitres — nombre de fenêtres',
      quantity: 8,
      unitLabel: 'fenêtres',
      unitPrice: xof(500),
      amount: xof(4000),
    });
  });

  it('ancien format toléré, transmis tel quel ; les deux formats ne se mélangent pas', async () => {
    const legacy = await http()
      .post('/api/v1/cleaning/simulations')
      .send({
        serviceCode: 'home_cleaning',
        premisesType: 'house',
        quantity: 6,
        options: ['windows'],
        commune: 'Cotonou',
      });
    expect(legacy.status).toBe(200);
    const sent = cleaning.stub.last('simulate')!.request;
    expect(sent).toMatchObject({
      premisesType: 'house',
      quantity: 6,
      options: ['windows'],
      optionSelections: [],
    });
    expect(sent['answers']).toBeFalsy();

    const refused = async (body: object) => {
      cleaning.stub.reset();
      const res = await http().post('/api/v1/cleaning/simulations').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
      expect(cleaning.stub.last('simulate')).toBeUndefined();
    };
    const base = { serviceCode: 'home_cleaning', commune: 'Cotonou' };
    await refused({ ...base, answers: ANSWERS, quantity: 6 });
    await refused({ ...base, answers: ANSWERS, options: ['windows'] });
    await refused({ ...base, premisesType: 'house', quantity: 6, options: OPTIONS });
    await refused({ ...base, premisesType: 'house' });
    await refused({ ...base, premisesType: 'house', quantity: 6, frequency: 'biweekly' });
    await refused({ ...base, answers: { rooms: 2.5 } });
  });

  it('demande de devis au nouveau format ; réponses et détail du calcul présentés', async () => {
    const { premisesType: _premises, quantity: _quantity, ...rest } = QUOTE_BODY;
    const res = await http()
      .post('/api/v1/cleaning/quote-requests')
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'demande-form-01')
      .send({ ...rest, answers: ANSWERS, options: OPTIONS, frequency: 'once' });
    expect(res.status).toBe(200);
    expect(cleaning.stub.last('requestQuote')!.request).toMatchObject({
      answers: { values: { rooms: { numberValue: 6 } } },
      frequency: 'once',
      premisesType: '',
    });
    expect(res.body).toMatchObject({
      answers: ANSWERS,
      selectedOptions: OPTIONS,
      frequency: 'once',
      pricingVersion: 3,
      calculation: { priced: true, computedPrice: xof(32550) },
    });
  });

  it('formulaire public sans prix ; définition complète au back-office', async () => {
    const services = await http().get('/api/v1/cleaning/services');
    expect(services.body.data[0].form.fields[1]).toEqual({
      code: 'condition',
      label: 'État',
      type: 'choice',
      required: true,
      helpText: 'Selon la dernière remise en état.',
      unitLabel: null,
      min: null,
      max: null,
      choices: [
        { code: 'normal', label: 'Normal' },
        { code: 'dirty', label: 'Sale' },
      ],
    });
    const catalog = await http()
      .get('/api/v1/admin/cleaning/catalog')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${admin}`);
    expect(catalog.status).toBe(200);
    const [service] = catalog.body.services;
    expect(service.fields[1].choices).toEqual([
      { code: 'normal', label: 'Normal', supplement: xof(0), coefficientBp: null, active: true },
      { code: 'dirty', label: 'Sale', supplement: null, coefficientBp: 12000, active: true },
    ]);
    expect(service.fields[2]).toMatchObject({
      type: 'boolean',
      supplementIfYes: null,
      coefficientBpIfYes: 11000,
    });
    expect(service.pricing).toMatchObject({
      unitPrice: xof(4500),
      teamSize: { fieldCode: 'rooms' },
      frequencies: [{ code: 'once', label: 'Une fois', coefficientBp: 10000, active: true }],
    });
  });

  const DEFINITION = {
    name: 'Entretien de jardin',
    active: true,
    fields: [
      {
        code: 'surface',
        label: 'Superficie',
        type: 'number',
        required: true,
        active: true,
        unitLabel: 'm²',
        min: 1,
        max: 100000,
        pricePerUnit: 150,
      },
      {
        code: 'condition',
        label: 'État',
        type: 'choice',
        required: true,
        active: true,
        choices: [
          { code: 'overgrown', label: 'Envahi', supplement: null, coefficientBp: 13000, active: true },
        ],
      },
    ],
    options: [{ code: 'green_waste_removal', label: 'Déchets verts', active: true, flatPrice: 10000 }],
    pricing: {
      minimumPrice: null,
      frequencies: [{ code: 'monthly', label: 'Chaque mois', coefficientBp: 9000, active: true }],
      teamSize: { fieldCode: 'surface', unitsPerAgent: 300, minAgents: 1, maxAgents: 6 },
    },
  };

  it('prestation complète enregistrée ; ancien corps refusé', async () => {
    const save = (body: object) =>
      http()
        .put('/api/v1/admin/cleaning/catalog/services/garden_maintenance')
        .set('Origin', ORIGINS.backoffice)
        .set('Authorization', `Bearer ${admin}`)
        .send(body);
    expect((await save(DEFINITION)).status).toBe(200);
    const service = cleaning.stub.last('saveService')!.request['service'] as Record<string, unknown>;
    expect(service).toMatchObject({
      code: 'garden_maintenance',
      unit: '',
      fields: [
        { code: 'surface', type: 'number', min: 1, max: 100000, pricePerUnit: xof(150), unitLabel: 'm²' },
        { code: 'condition', type: 'choice', choices: [{ code: 'overgrown', coefficientBp: 13000 }] },
      ],
      options: [{ code: 'green_waste_removal', flatPrice: xof(10000), fields: [] }],
      pricing: {
        teamSize: { fieldCode: 'surface' },
        frequencies: [{ code: 'monthly', coefficientBp: 9000 }],
      },
    });

    cleaning.stub.reset();
    const legacy = await save({
      name: 'Nettoyage à domicile',
      unit: 'room',
      active: true,
      pricing: { unitPrice: 5000, minimumPrice: null },
    });
    expect(legacy.status).toBe(400);
    expect(legacy.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
    expect(cleaning.stub.last('saveService')).toBeUndefined();
    // Propriété d'un autre type de champ refusée.
    const mixed = { ...DEFINITION, fields: [{ ...DEFINITION.fields[0], choices: [] }] };
    expect((await save(mixed)).status).toBe(400);
  });

  it('essai d’une grille : définition et réponses transmises, détail du calcul présenté', async () => {
    const res = await http()
      .post('/api/v1/admin/cleaning/catalog/services/garden_maintenance/preview')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        definition: DEFINITION,
        answers: { surface: 400, condition: 'overgrown' },
        commune: 'Cotonou',
        frequency: 'monthly',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      serviceCode: 'home_cleaning',
      covered: true,
      calculation: { priced: true },
    });
    expect(cleaning.stub.last('previewService')!.request).toMatchObject({
      serviceCode: 'garden_maintenance',
      definition: { code: 'garden_maintenance', name: 'Entretien de jardin' },
      answers: { values: { surface: { numberValue: 400 }, condition: { choiceValue: 'overgrown' } } },
      frequency: 'monthly',
    });
    const forbidden = await http()
      .post('/api/v1/admin/cleaning/catalog/services/garden_maintenance/preview')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`)
      .send({ answers: {}, commune: 'Cotonou' });
    expect(forbidden.status).toBe(403);
  });

  // --- Parcours par lieu (ADR-034) ---------------------------------------------------------------

  const HOUSE_ITEM = {
    serviceCode: 'house_cleaning',
    answers: {
      surface: 180,
      bedrooms: 4,
      bathrooms: 2,
      front_yard: true,
      back_yard: false,
      condition: 'normal',
    },
    options: [{ code: 'windows', answers: { window_count: 6 } }],
    frequency: 'once',
  };
  const GROUP_BODY = {
    placeType: 'house',
    location: { latitude: 6.3654, longitude: 2.4183, accuracyMeters: 12 },
    landmark: 'Portail vert',
    items: [
      HOUSE_ITEM,
      { serviceCode: 'garden_maintenance', answers: { surface: 250, condition: 'overgrown' } },
    ],
    preferredSlots: [{ start: '2026-11-20T08:00:00Z', end: '2026-11-20T11:00:00Z' }],
  };

  it('catalogue par lieu : public, lieux et prestations présentés', async () => {
    const res = await http().get('/api/v1/cleaning/catalog');
    expect(res.status).toBe(200);
    expect(res.body.placeTypes).toEqual([
      {
        code: 'house',
        label: 'Maison',
        description: 'Maison individuelle, avec ou sans cour.',
        icon: 'house',
        displayOrder: 10,
        serviceCodes: ['home_cleaning'],
      },
    ]);
    expect(res.body.services[0]).toMatchObject({
      code: 'home_cleaning',
      form: { fields: expect.any(Array) },
    });
    expect(cleaning.stub.last('getPlaceCatalog')!.context?.user).toBeUndefined();
  });

  it('estimation : public, prestations transmises au nouveau format, total en entier XOF', async () => {
    const res = await http()
      .post('/api/v1/cleaning/estimates')
      .send({ placeType: 'house', items: [HOUSE_ITEM] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      placeType: 'house',
      commune: null,
      communeApplied: false,
      status: 'priced',
      total: 31000,
      currency: 'XOF',
      items: [
        {
          serviceCode: 'home_cleaning',
          serviceName: 'Nettoyage à domicile',
          computedPrice: xof(31000),
          recommendedTeamSize: 2,
          missingPrices: [],
        },
      ],
    });
    const call = cleaning.stub.last('estimate')!;
    expect(call.request).toMatchObject({ placeType: 'house', commune: '' });
    expect((call.request['items'] as { answers: unknown; optionSelections: unknown[] }[])[0]).toMatchObject({
      serviceCode: 'house_cleaning',
      answers: { values: { surface: { numberValue: 180 }, front_yard: { booleanValue: true } } },
      optionSelections: [{ code: 'windows' }],
      frequency: 'once',
    });
  });

  it('estimation : corps refusés (ancien format, aucune prestation, plus de 10, champ inconnu)', async () => {
    const send = (body: object) => http().post('/api/v1/cleaning/estimates').send(body);
    expect((await send({ placeType: 'house', items: [] })).status).toBe(400);
    expect((await send({ placeType: 'house', items: Array(11).fill(HOUSE_ITEM) })).status).toBe(400);
    expect(
      (
        await send({
          placeType: 'house',
          items: [{ serviceCode: 'home_cleaning', premisesType: 'house', quantity: 3 }],
        })
      ).status,
    ).toBe(400);
    expect((await send({ placeType: 'House', items: [HOUSE_ITEM] })).status).toBe(400);
    expect((await send({ placeType: 'house', items: [HOUSE_ITEM], surprise: 1 })).status).toBe(400);
    expect(cleaning.stub.last('estimate')).toBeUndefined();
  });

  it('simulation sans commune : acceptée, communeApplied présenté', async () => {
    const res = await http()
      .post('/api/v1/cleaning/simulations')
      .send({ serviceCode: 'home_cleaning', answers: { rooms: 6 }, frequency: 'once' });
    expect(res.status).toBe(200);
    expect(res.body.communeApplied).toBe(true);
    expect(cleaning.stub.last('simulate')!.request).toMatchObject({ commune: '' });
  });

  it('position : connecté seulement, coordonnées dans le corps, bornes contrôlées', async () => {
    const resolve = (body: object, token: string | null = customer) => {
      const req = http().post('/api/v1/cleaning/locations/resolve');
      return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
    };
    expect((await resolve({ latitude: 6.3654, longitude: 2.4183 }, null)).status).toBe(401);
    expect((await resolve({ latitude: 91, longitude: 2.4183 })).status).toBe(400);
    expect((await resolve({ latitude: 6.3654, longitude: -181 })).status).toBe(400);
    expect((await resolve({ latitude: '6.36', longitude: 2.4 })).status).toBe(400);
    expect(cleaning.stub.last('resolveLocation')).toBeUndefined();
    const res = await resolve({ latitude: 6.3654, longitude: 2.4183 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      latitude: 6.4489,
      longitude: 2.3556,
      commune: 'Abomey-Calavi',
      zoneCode: 'abomey-calavi',
      served: true,
      displayAddress: 'Zogbadjè, Abomey-Calavi, Bénin',
      provider: 'nominatim',
    });
    const call = cleaning.stub.last('resolveLocation')!;
    expect(call.request).toEqual({ latitude: 6.3654, longitude: 2.4183 });
    expect(call.context?.user?.userId).toBe(USER_ID);
  });

  it('groupe de demandes : profil vérifié, clé obligatoire, position et prestations transmises', async () => {
    const post = (body: object, key?: string) => {
      const req = http()
        .post('/api/v1/cleaning/quote-request-groups')
        .set('Origin', ORIGINS.web)
        .set('Authorization', `Bearer ${customer}`);
      return (key ? req.set('Idempotency-Key', key) : req).send(body);
    };
    expect((await post(GROUP_BODY)).status).toBe(400);
    expect((await post({ ...GROUP_BODY, landmark: '' }, 'groupe-0001')).status).toBe(400);
    expect((await post({ ...GROUP_BODY, location: { latitude: 6.36 } }, 'groupe-0001')).status).toBe(400);
    const res = await post(GROUP_BODY, 'groupe-0001');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      groupId: IDS.group,
      placeType: 'house',
      commune: 'Abomey-Calavi',
      zoneCode: 'abomey-calavi',
    });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      groupId: IDS.group,
      groupSize: 2,
      placeType: 'house',
      placeTypeLabel: 'Maison',
      serviceName: 'Nettoyage à domicile',
      location: { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 15 },
      landmark: 'Portail bleu',
      geocodingProvider: 'nominatim',
      geocodedAddress: 'Zogbadjè, Abomey-Calavi, Bénin',
    });
    const call = cleaning.stub.last('requestQuoteGroup')!;
    expect(call.request).toMatchObject({
      idempotencyKey: 'groupe-0001',
      placeType: 'house',
      location: { latitude: 6.3654, longitude: 2.4183, accuracyMeters: 12 },
      landmark: 'Portail vert',
      commune: '',
      comment: '',
    });
    expect((call.request['items'] as object[])[1]).toMatchObject({
      serviceCode: 'garden_maintenance',
      optionSelections: [],
      frequency: '',
      requestedTeamSize: 0,
    });

    identity.stub.on('getMe', async () => ({
      user: protoUser,
      profileIncomplete: true,
      activeContext: protoIndividual,
    }));
    cleaning.stub.reset();
    const incomplete = await post(GROUP_BODY, 'groupe-0002');
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.code).toBe('IDENTITY_PROFILE_INCOMPLETE');
    expect(cleaning.stub.last('requestQuoteGroup')).toBeUndefined();
  });

  it('groupe : lecture par le propriétaire, identifiant contrôlé', async () => {
    const get = (id: string) =>
      http().get(`/api/v1/cleaning/quote-request-groups/${id}`).set('Authorization', `Bearer ${customer}`);
    expect((await get('pas-un-uuid')).status).toBe(400);
    const res = await get(IDS.group);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { id: string }) => item.id)).toEqual([IDS.request, IDS.sibling]);
    expect(cleaning.stub.last('getRequestGroup')!.request).toEqual({ groupId: IDS.group });
  });

  it('back-office : demandes sœurs, filtres de groupe, de lieu et de prestation transmis', async () => {
    const detail = await http()
      .get(`/api/v1/admin/cleaning/quote-requests/${IDS.request}`)
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`);
    expect(detail.status).toBe(200);
    expect(detail.body.groupRequests).toEqual([
      {
        id: IDS.sibling,
        serviceCode: 'garden_maintenance',
        serviceName: 'Entretien de jardin',
        status: 'visit_scheduled',
        visitScheduledAt: '2026-10-26T09:00:00.000Z',
        quoteTotal: null,
        missionId: null,
      },
    ]);
    const list = await http()
      .get('/api/v1/admin/cleaning/quote-requests')
      .query({ groupId: IDS.group, placeType: 'house', serviceCode: 'home_cleaning' })
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`);
    expect(list.status).toBe(200);
    expect(cleaning.stub.last('listQuoteRequests')!.request).toMatchObject({
      groupId: IDS.group,
      placeType: 'house',
      serviceCode: 'home_cleaning',
    });
    const missions = await http()
      .get('/api/v1/admin/cleaning/missions')
      .query({ groupId: IDS.group, serviceCode: 'septic_emptying' })
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`);
    expect(missions.status).toBe(200);
    expect(missions.body.data[0]).toMatchObject({
      location: { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 15 },
      landmark: 'Portail bleu',
      groupId: IDS.group,
      placeType: 'house',
    });
    expect(cleaning.stub.last('listMissions')!.request).toMatchObject({
      groupId: IDS.group,
      serviceCode: 'septic_emptying',
    });
    const refused = await http()
      .get('/api/v1/admin/cleaning/quote-requests')
      .query({ groupId: 'groupe-1' })
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${staff}`);
    expect(refused.status).toBe(400);
  });

  it('types de lieu : administration et double authentification, corps contrôlé, cohérence présentée', async () => {
    const list = (token: string) =>
      http()
        .get('/api/v1/admin/cleaning/place-types')
        .set('Origin', ORIGINS.backoffice)
        .set('Authorization', `Bearer ${token}`);
    expect((await list(staff)).status).toBe(403);
    const res = await list(admin);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      code: 'house',
      unknownServiceCodes: ['old_service'],
      inactiveServiceCodes: ['garden_maintenance'],
      publiclyVisible: true,
      visibilityReason: null,
      updatedByName: 'Afi Superviseure',
    });
    const save = (code: string, body: object) =>
      http()
        .put(`/api/v1/admin/cleaning/place-types/${code}`)
        .set('Origin', ORIGINS.backoffice)
        .set('Authorization', `Bearer ${admin}`)
        .send(body);
    const body = {
      label: 'Villa',
      icon: 'villa',
      displayOrder: 20,
      active: true,
      serviceCodes: ['house_cleaning'],
    };
    expect((await save('Villa', body)).status).toBe(400);
    expect((await save('villa', { ...body, displayOrder: -1 })).status).toBe(400);
    expect((await save('villa', { ...body, serviceCodes: ['House'] })).status).toBe(400);
    expect((await save('villa', body)).status).toBe(200);
    expect(cleaning.stub.last('savePlaceType')!.request).toMatchObject({
      placeType: {
        code: 'villa',
        label: 'Villa',
        description: '',
        icon: 'villa',
        serviceCodes: ['house_cleaning'],
      },
    });
  });

  it('catalogue du back-office et zones : prestations sans lieu, lieux touchés, noms alternatifs', async () => {
    const catalog = await http()
      .get('/api/v1/admin/cleaning/catalog')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${admin}`);
    expect(catalog.body.unplacedServiceCodes).toEqual(['pest_control']);
    const zone = await http()
      .post('/api/v1/admin/cleaning/zones')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${admin}`)
      .send({ commune: 'Sèmè-Podji', aliases: ['Sèmè-Kpodji'] });
    expect(zone.status).toBe(200);
    expect(zone.body.aliases).toEqual(['Abomey Calavi']);
    expect(cleaning.stub.last('saveZone')!.request).toEqual({
      commune: 'Sèmè-Podji',
      aliases: { names: ['Sèmè-Kpodji'] },
    });
    await http()
      .post('/api/v1/admin/cleaning/zones')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${admin}`)
      .send({ commune: 'Cotonou' });
    // Message absent : noms alternatifs en vigueur gardés par cleaning.
    expect(cleaning.stub.last('saveZone')!.request['aliases'] ?? null).toBeNull();
  });

  // --- ADR-035 : demandes groupées, visites, position, zones ---------------------------------------

  const agentToken = () =>
    keys.accessToken({
      claims: {
        client_id: 'backoffice',
        mfa: true,
        roles: [{ role: 'cleaning_agent', scopeType: 'global' }],
      },
    });
  const backoffice = (req: request.Test, bearer: string) =>
    req.set('Origin', ORIGINS.backoffice).set('Authorization', `Bearer ${bearer}`);
  const GROUP = `/api/v1/admin/cleaning/quote-request-groups/${IDS.group}`;

  it('client : annulation et acceptation du groupe, clé obligatoire, totaux présentés', async () => {
    const cancel = () =>
      http()
        .post(`/api/v1/cleaning/quote-request-groups/${IDS.group}/cancel`)
        .set('Authorization', `Bearer ${customer}`);
    expect((await cancel().send({})).status).toBe(400);
    const res = await cancel().set('Idempotency-Key', 'annul-0001').send({ reason: 'Plus besoin' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      groupId: IDS.group,
      affectedRequestIds: [IDS.request],
      skipped: [{ requestId: IDS.sibling, status: 'accepted', reason: 'not_open' }],
      group: { groupId: IDS.group, quotesTotal: null, remainingDue: null },
    });
    expect(cleaning.stub.last('cancelRequestGroup')!.request).toMatchObject({
      groupId: IDS.group,
      reason: 'Plus besoin',
      idempotencyKey: 'annul-0001',
    });
    // Corps facultatif.
    expect((await cancel().set('Idempotency-Key', 'annul-0002')).status).toBe(200);

    const accept = await http()
      .post(`/api/v1/cleaning/quote-request-groups/${IDS.group}/accept`)
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'accept-0001')
      .send({
        slotStart: '2026-11-05T08:00:00Z',
        paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
      });
    expect(accept.status).toBe(200);
    expect(accept.body).toMatchObject({ missionIds: [IDS.mission], group: { quotesTotal: xof(30000) } });
    const bad = await http()
      .post(`/api/v1/cleaning/quote-request-groups/${IDS.group}/accept`)
      .set('Authorization', `Bearer ${customer}`)
      .set('Idempotency-Key', 'accept-0002')
      .send({ slotStart: 'demain' });
    expect(bad.status).toBe(400);
    expect(cleaning.stub.calls.filter((call) => call.method === 'acceptGroupQuotes')).toHaveLength(1);
  });

  it('back-office : visite commune, refus et devis du groupe ; supervision exigée, clé facultative transmise', async () => {
    const visit = await backoffice(http().post(`${GROUP}/visits`), staff)
      .set('Idempotency-Key', 'visite-0001')
      .send({ scheduledAt: '2026-10-27T09:00:00Z', agentId: IDS.agent, excludeRequestIds: [IDS.sibling] });
    expect(visit.status).toBe(200);
    expect(visit.body).toMatchObject({
      groupVisitId: IDS.groupVisit,
      requests: [{ id: IDS.request }, { id: IDS.sibling }],
    });
    expect(cleaning.stub.last('scheduleGroupVisit')!.request).toMatchObject({
      groupId: IDS.group,
      excludeRequestIds: [IDS.sibling],
      idempotencyKey: 'visite-0001',
    });
    const agent = await agentToken();
    expect(
      (
        await backoffice(http().post(`${GROUP}/visits`), agent).send({
          scheduledAt: '2026-10-27T09:00:00Z',
          agentId: IDS.agent,
        })
      ).status,
    ).toBe(403);
    const reject = await backoffice(http().post(`${GROUP}/reject`), staff).send({ reason: 'Hors zone' });
    expect(reject.status).toBe(200);
    expect(cleaning.stub.last('rejectRequestGroup')!.request).toMatchObject({
      reason: 'Hors zone',
      idempotencyKey: '',
    });
    expect((await backoffice(http().post(`${GROUP}/reject`), staff).send({})).status).toBe(400);

    const quotes = await backoffice(http().post(`${GROUP}/quotes`), staff).send({
      proposedSlots: [{ start: '2026-11-05T08:00:00Z', end: '2026-11-05T11:00:00Z' }],
      quotes: [
        { requestId: IDS.request, durationMinutes: 180 },
        {
          requestId: IDS.sibling,
          lines: [{ label: 'Jardin', quantity: 1, unitPrice: 20000 }],
          durationMinutes: 60,
        },
      ],
    });
    expect(quotes.status).toBe(200);
    expect(cleaning.stub.last('sendGroupQuotes')!.request).toMatchObject({
      quotes: [
        { requestId: IDS.request, lines: [], teamSize: 0 },
        { requestId: IDS.sibling, lines: [{ unitPrice: xof(20000), amount: xof(20000) }] },
      ],
    });
    expect(
      (await backoffice(http().post(`${GROUP}/quotes`), staff).send({ proposedSlots: [], quotes: [] }))
        .status,
    ).toBe(400);
  });

  it('agent : compte rendu commun et par demande, liste de ses visites, correction de position', async () => {
    const agent = await agentToken();
    expect(
      (await backoffice(http().post(`${GROUP}/visits/complete`), agent).send({ report: 'Vu' })).status,
    ).toBe(200);
    expect(
      (
        await backoffice(http().post(`/api/v1/admin/cleaning/visits/${IDS.visit}/complete`), agent).send({
          report: 'Vu',
        })
      ).status,
    ).toBe(200);
    expect(cleaning.stub.last('completeVisit')!.context?.user?.roles).toMatchObject([
      { role: 'cleaning_agent', scopeType: 'global' },
    ]);

    const visits = await backoffice(http().get('/api/v1/admin/cleaning/visits'), agent).query({
      status: 'scheduled',
      from: '2026-10-26T00:00:00Z',
      groupId: IDS.group,
    });
    expect(visits.status).toBe(200);
    expect(visits.body.data[0]).toMatchObject({
      id: IDS.groupVisit,
      landmark: 'Portail bleu',
      requests: [{ requestId: IDS.request, visitId: IDS.visit, serviceName: 'Nettoyage à domicile' }],
    });
    expect(cleaning.stub.last('listVisits')!.request).toMatchObject({
      status: 'scheduled',
      groupId: IDS.group,
      agentId: '',
    });
    expect(
      (await backoffice(http().get('/api/v1/admin/cleaning/visits'), agent).query({ status: 'done' })).status,
    ).toBe(400);
    expect(
      (await http().get('/api/v1/admin/cleaning/visits').set('Authorization', `Bearer ${customer}`)).status,
    ).toBe(403);

    const location = await backoffice(
      http().put(`/api/v1/admin/cleaning/quote-requests/${IDS.request}/location`),
      agent,
    ).send({
      latitude: 6.37,
      longitude: 2.39,
      landmark: 'Portail vert',
    });
    expect(location.status).toBe(200);
    expect(location.body).toMatchObject({
      updatedRequestIds: [IDS.request, IDS.sibling],
      updatedMissionIds: [IDS.mission],
    });
    expect(cleaning.stub.last('correctRequestLocation')!.request).toMatchObject({
      location: { latitude: 6.37, longitude: 2.39, accuracyMeters: 0 },
      landmark: 'Portail vert',
      commune: '',
    });
    expect(
      (
        await backoffice(
          http().put(`/api/v1/admin/cleaning/quote-requests/${IDS.request}/location`),
          agent,
        ).send({ latitude: 95, longitude: 2 })
      ).status,
    ).toBe(400);
  });

  // --- Plan de passages (ADR-052) -------------------------------------------------------------------

  const WEEKLY = {
    mode: 'weekly',
    startDate: '2026-11-10',
    endDate: '2027-11-11',
    weekdays: ['mon', 'wed', 'sat'],
    startTime: '08:00',
  };

  it('aperçu public d’un plan : corps traduit, dates présentées ; forme refusée par la gateway', async () => {
    const res = await http()
      .post('/api/v1/cleaning/schedules/preview')
      .send({
        mode: 'monthly',
        startDate: '2026-12-01',
        endDate: '2027-05-31',
        weekdays: ['mon'],
        weeksOfMonth: [1, 'last'],
        startTime: '09:30',
      });
    expect(res.status).toBe(200);
    expect(cleaning.stub.last('previewSchedule')!.request).toEqual({
      schedule: {
        mode: 'monthly',
        dates: [],
        startDate: '2026-12-01',
        endDate: '2027-05-31',
        weekdays: ['mon'],
        everyWeeks: 0,
        monthDays: [],
        weeksOfMonth: ['1', 'last'],
        startTime: '09:30',
        excludedDates: [],
        extraDates: [],
      },
    });
    expect(res.body).toEqual({
      dates: ['2026-11-05', '2026-11-12'],
      count: 2,
      firstDate: '2026-11-05',
      lastDate: '2026-11-12',
      warnings: [],
    });
    for (const body of [
      { ...WEEKLY, mode: 'daily' },
      { ...WEEKLY, startTime: '8h' },
      { ...WEEKLY, weekdays: ['lundi'] },
      { ...WEEKLY, weeksOfMonth: [5] },
      { ...WEEKLY, startDate: '10/11/2026' },
      { ...WEEKLY, unknown: true },
    ]) {
      const refused = await http().post('/api/v1/cleaning/schedules/preview').send(body);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
    }
  });

  it('simulation avec un plan : montant sur le nombre de passages ; plan et dates présentés partout', async () => {
    cleaning.stub.on('simulate', async () => ({
      ...stubDefault('simulate'),
      schedule: {
        dates: ['2026-11-11'],
        count: 1,
        firstDate: '2026-11-11',
        lastDate: '2026-11-11',
        warnings: [],
      },
      scheduleTotal: xof(37400),
      scheduleEstimate: { low: xof(33500), high: xof(43000) },
    }));
    const res = await http()
      .post('/api/v1/cleaning/simulations')
      .send({ serviceCode: 'home_cleaning', answers: {}, schedule: WEEKLY });
    expect(res.status).toBe(200);
    expect(cleaning.stub.last('simulate')!.request).toMatchObject({
      schedule: { mode: 'weekly', everyWeeks: 0 },
    });
    expect(res.body.schedule).toEqual({
      dates: ['2026-11-11'],
      count: 1,
      firstDate: '2026-11-11',
      lastDate: '2026-11-11',
      warnings: [],
      total: xof(37400),
      estimate: { low: xof(33500), high: xof(43000) },
    });

    const mission = await http()
      .get(`/api/v1/cleaning/missions/${IDS.mission}`)
      .set('Authorization', `Bearer ${customer}`);
    expect(mission.body).toMatchObject({
      schedule: {
        mode: 'weekly',
        startDate: '2026-11-05',
        weekdays: ['thu'],
        everyWeeks: 1,
        weeksOfMonth: [],
      },
      scheduledDates: ['2026-11-05', '2026-11-12'],
    });
  });

  it('devis sans créneau avec un plan ; passage planifié sans date (prochaine date du plan)', async () => {
    const quote = await backoffice(
      http().post(`/api/v1/admin/cleaning/quote-requests/${IDS.request}/quote`),
      staff,
    ).send({
      durationMinutes: 180,
      schedule: { mode: 'dates', dates: ['2026-11-20', '2026-12-04'], startTime: '08:00' },
    });
    expect(quote.status).toBe(200);
    expect(cleaning.stub.last('sendQuote')!.request).toMatchObject({
      proposedSlots: [],
      schedule: { mode: 'dates', dates: ['2026-11-20', '2026-12-04'], startDate: '', endDate: '' },
    });
    const planned = await backoffice(
      http().post(`/api/v1/admin/cleaning/missions/${IDS.mission}/interventions`),
      staff,
    ).send({ durationMinutes: 180, agentIds: [IDS.agent] });
    expect(planned.status).toBe(200);
    expect(cleaning.stub.last('scheduleIntervention')!.request).toMatchObject({ scheduledStart: '' });
  });

  it('planification en lot : clé obligatoire transmise, dates sautées, conflits en 409 avec leurs dates', async () => {
    const url = `/api/v1/admin/cleaning/missions/${IDS.mission}/interventions/batch`;
    const body = { until: '2026-12-31', durationMinutes: 120, agentIds: [IDS.agent], skipConflicts: true };
    const missing = await backoffice(http().post(url), staff).send(body);
    expect(missing.status).toBe(400);
    expect(cleaning.stub.last('scheduleInterventionBatch')).toBeUndefined();

    const res = await backoffice(http().post(url), staff).set('Idempotency-Key', 'lot-cle-0001').send(body);
    expect(res.status).toBe(200);
    expect(cleaning.stub.last('scheduleInterventionBatch')!.request).toEqual({
      missionId: IDS.mission,
      dates: [],
      until: '2026-12-31',
      startTime: '',
      durationMinutes: 120,
      agentIds: [IDS.agent],
      teamId: '',
      skipConflicts: true,
      idempotencyKey: 'lot-cle-0001',
    });
    expect(res.body).toMatchObject({
      mission: { id: IDS.mission, scheduledDates: ['2026-11-05', '2026-11-12'] },
      interventionIds: [IDS.intervention],
      scheduledDates: ['2026-11-12'],
      skipped: [{ date: '2026-11-05', agentIds: [IDS.agent] }],
    });

    const conflicts = [{ date: '2026-11-05', agentIds: [IDS.agent] }];
    cleaning.stub.on('scheduleInterventionBatch', () =>
      Promise.reject(
        AppError.conflict('CLEANING_TEAM_UNAVAILABLE', 'Pris.', { agentIds: [IDS.agent], conflicts }),
      ),
    );
    const refused = await backoffice(http().post(url), staff)
      .set('Idempotency-Key', 'lot-cle-0002')
      .send({ durationMinutes: 120, agentIds: [IDS.agent] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CLEANING_TEAM_UNAVAILABLE', details: { conflicts } });
  });

  it('planification commune des missions d’un groupe ; conflit d’agenda en 409', async () => {
    const url = `/api/v1/admin/cleaning/mission-groups/${IDS.group}/interventions`;
    const body = { scheduledStart: '2026-11-05T08:00:00Z', durationMinutes: 180, agentIds: [IDS.agent] };
    const res = await backoffice(http().post(url), staff).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ groupId: IDS.group, scheduledMissionIds: [IDS.mission], skipped: [] });
    expect(cleaning.stub.last('scheduleGroupInterventions')!.request).toMatchObject({
      missionIds: [],
      teamId: '',
    });
    cleaning.stub.on('scheduleGroupInterventions', () =>
      Promise.reject(AppError.conflict('CLEANING_TEAM_UNAVAILABLE', 'Pris.', { agentIds: [IDS.agent] })),
    );
    const conflict = await backoffice(http().post(url), staff).send(body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CLEANING_TEAM_UNAVAILABLE');
  });

  it('zones : activité présentée, confirmation transmise, 409 sans confirmation ; réglage de conservation', async () => {
    const zones = await backoffice(http().get('/api/v1/admin/cleaning/zones'), admin);
    expect(zones.body.data[0]).toMatchObject({ openRequests: 3, activeMissions: 1 });
    expect(
      (await backoffice(http().post('/api/v1/admin/cleaning/zones/abomey-calavi/deactivate'), admin)).status,
    ).toBe(200);
    expect(cleaning.stub.last('deactivateZone')!.request).toMatchObject({
      code: 'abomey-calavi',
      confirm: false,
    });
    await backoffice(http().post('/api/v1/admin/cleaning/zones/abomey-calavi/deactivate'), admin).send({
      confirm: true,
    });
    expect(cleaning.stub.last('deactivateZone')!.request).toMatchObject({ confirm: true });
    cleaning.stub.on('deactivateZone', () =>
      Promise.reject(
        AppError.conflict('CLEANING_ZONE_HAS_ACTIVITY', 'Confirmez.', { openRequests: 3, activeMissions: 1 }),
      ),
    );
    const refused = await backoffice(
      http().post('/api/v1/admin/cleaning/zones/abomey-calavi/deactivate'),
      admin,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toMatchObject({ openRequests: 3, activeMissions: 1 });

    await backoffice(http().put('/api/v1/admin/cleaning/catalog/settings'), admin).send({
      quoteValidityDays: 15,
      minimumLeadHours: 48,
      freeCancellationHours: 24,
      maxOpenRequests: 5,
      depositPercent: 30,
      locationRetentionMonths: 6,
    });
    expect(cleaning.stub.last('updateSettings')!.request).toMatchObject({
      settings: { locationRetentionMonths: 6 },
    });
    expect(
      (
        await backoffice(http().put('/api/v1/admin/cleaning/catalog/settings'), admin).send({
          quoteValidityDays: 15,
          minimumLeadHours: 48,
          freeCancellationHours: 24,
          maxOpenRequests: 5,
          depositPercent: 30,
          locationRetentionMonths: 0,
        })
      ).status,
    ).toBe(400);
  });

  it('mesures constatées (ADR-037) : recalcul, correction, compte rendu avec mesures, réponses lisibles', async () => {
    const agent = await agentToken();
    const REQUEST = `/api/v1/admin/cleaning/quote-requests/${IDS.request}`;
    const measured = {
      answers: { housing_type: 'apartment', rooms: 8, bathrooms: 2, condition: 'very_dirty', pets: false },
      options: [{ code: 'windows', answers: { window_count: 12 } }],
      frequency: 'once',
    };

    const estimate = await backoffice(http().post(`${REQUEST}/estimate`), agent).send(measured);
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({
      requestId: IDS.request,
      commune: 'Abomey-Calavi',
      calculation: { priced: true, computedPrice: xof(45150) },
    });
    expect(cleaning.stub.last('estimateRequestPrice')!.request).toMatchObject({
      requestId: IDS.request,
      answers: { values: { rooms: { numberValue: 8 }, pets: { booleanValue: false } } },
      optionSelections: [{ code: 'windows', answers: { values: { window_count: { numberValue: 12 } } } }],
      frequency: 'once',
    });
    // Nouveau format seulement : answers obligatoire, ancien format et champ inconnu refusés.
    for (const body of [{}, { premisesType: 'house', quantity: 6 }, { ...measured, commune: 'Cotonou' }]) {
      expect((await backoffice(http().post(`${REQUEST}/estimate`), agent).send(body)).status).toBe(400);
    }
    expect(
      (await http().post(`${REQUEST}/estimate`).set('Authorization', `Bearer ${customer}`).send(measured))
        .status,
    ).toBe(403);

    const saved = await backoffice(http().put(`${REQUEST}/measurements`), staff).send(measured);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      measuredAnswers: { rooms: 8 },
      measuredOptions: [{ code: 'windows', answers: { window_count: 8 } }],
      measuredFrequency: 'once',
      measuredPricingVersion: 3,
      measuredAt: '2026-10-26T10:00:00.000Z',
      measuredBy: IDS.agent,
      measuredByName: 'Awa Dossou',
      measuredCalculation: { computedPrice: xof(45150) },
      answerSummary: {
        fields: [
          { code: 'housing_type', display: 'Appartement', unitLabel: null, value: 'apartment' },
          { code: 'rooms', type: 'number', value: 6, display: '6 pièces', unitLabel: 'pièces' },
          { code: 'pets', type: 'boolean', value: false, display: 'Non' },
        ],
        options: [{ optionCode: 'windows', label: 'Vitres', fields: [{ display: '8 fenêtres' }] }],
        frequency: { code: 'once', label: 'Une fois' },
      },
      measuredSummary: {
        fields: [expect.anything(), { code: 'rooms', display: '8 pièces' }, expect.anything()],
      },
    });
    expect(cleaning.stub.last('saveRequestMeasurements')!.request).toMatchObject({ requestId: IDS.request });

    // Mesures refusées par cleaning (devis déjà envoyé) : 422 et code transmis.
    cleaning.stub.on('saveRequestMeasurements', () =>
      Promise.reject(
        AppError.precondition('CLEANING_MEASUREMENTS_LOCKED', 'Devis déjà envoyé.', { status: 'quote_sent' }),
      ),
    );
    const locked = await backoffice(http().put(`${REQUEST}/measurements`), agent).send(measured);
    expect(locked.status).toBe(422);
    expect(locked.body.error).toMatchObject({
      code: 'CLEANING_MEASUREMENTS_LOCKED',
      details: { status: 'quote_sent' },
    });

    // Compte rendu avec mesures (par demande et commun) ; sans mesures : message absent.
    expect(
      (
        await backoffice(http().post(`/api/v1/admin/cleaning/visits/${IDS.visit}/complete`), agent).send({
          report: 'Huit pièces',
          measurements: measured,
        })
      ).status,
    ).toBe(200);
    expect(cleaning.stub.last('completeVisit')!.request).toMatchObject({
      visitId: IDS.visit,
      measurements: { answers: { values: { rooms: { numberValue: 8 } } }, frequency: 'once' },
    });
    await backoffice(http().post(`/api/v1/admin/cleaning/visits/${IDS.visit}/complete`), agent).send({
      report: 'Vu',
    });
    expect(cleaning.stub.last('completeVisit')!.request['measurements'] ?? null).toBeNull();
    const group = await backoffice(http().post(`${GROUP}/visits/complete`), agent).send({
      report: 'Maison et jardin vus',
      measurements: [
        { requestId: IDS.sibling, answers: { surface: 600, condition: 'overgrown' }, frequency: 'once' },
      ],
    });
    expect(group.status).toBe(200);
    expect(cleaning.stub.last('completeGroupVisit')!.request).toMatchObject({
      measurements: [
        {
          requestId: IDS.sibling,
          answers: { values: { surface: { numberValue: 600 }, condition: { choiceValue: 'overgrown' } } },
          optionSelections: [],
          frequency: 'once',
        },
      ],
    });
    expect(
      (
        await backoffice(http().post(`${GROUP}/visits/complete`), agent).send({
          report: 'Vu',
          measurements: [{ requestId: 'pas-un-uuid', answers: {} }],
        })
      ).status,
    ).toBe(400);
  });
  it('agent seul : compte rendu et correction des mesures sans montant ; recalcul avec son calcul', async () => {
    const agent = await agentToken();
    const REQUEST = `/api/v1/admin/cleaning/quote-requests/${IDS.request}`;
    // Ce que cleaning renvoie à un agent seul : réponses et mesures, aucun montant (ADR-037).
    const forAgent = {
      request: {
        ...protoRequest,
        estimate: undefined,
        quote: undefined,
        calculation: undefined,
        measurement: { ...protoRequest.measurement!, calculation: undefined },
      },
    };
    cleaning.stub.on('completeVisit', async () => forAgent);
    cleaning.stub.on('saveRequestMeasurements', async () => forAgent);
    const measured = { answers: { housing_type: 'apartment', rooms: 8 }, frequency: 'once' };
    const noAmounts = {
      estimate: null,
      quote: null,
      calculation: null,
      measuredCalculation: null,
      answers: { rooms: 6 },
      measuredAnswers: { rooms: 8 },
    };

    const done = await backoffice(
      http().post(`/api/v1/admin/cleaning/visits/${IDS.visit}/complete`),
      agent,
    ).send({
      report: 'Huit pièces',
      measurements: measured,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject(noAmounts);
    const saved = await backoffice(http().put(`${REQUEST}/measurements`), agent).send(measured);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject(noAmounts);

    // Le recalcul reste son outil de saisie : le calcul lui est présenté.
    const estimate = await backoffice(http().post(`${REQUEST}/estimate`), agent).send(measured);
    expect(estimate.status).toBe(200);
    expect(estimate.body.calculation).toMatchObject({ priced: true });
  });

  it('liste des visites : réponses du client et mesures pour préremplir ; aucun montant pour un agent', async () => {
    const supervision = await backoffice(http().get('/api/v1/admin/cleaning/visits'), staff);
    expect(supervision.status).toBe(200);
    expect(supervision.body.data[0].requests[0]).toMatchObject({
      serviceCode: 'home_cleaning',
      serviceName: 'Nettoyage à domicile',
      placeType: 'house',
      placeTypeLabel: 'Maison',
      answers: { housing_type: 'apartment', rooms: 6, pets: false },
      selectedOptions: [{ code: 'windows', answers: { window_count: 8 } }],
      frequency: 'once',
      pricingVersion: 3,
      answerSummary: { fields: [{ code: 'housing_type', display: 'Appartement' }, {}, {}] },
      calculation: { priced: true },
      measuredAnswers: { rooms: 8 },
      measuredOptions: [{ code: 'windows', answers: { window_count: 8 } }],
      measuredFrequency: 'once',
      measuredCalculation: { computedPrice: xof(45150) },
      measuredBy: IDS.agent,
      measuredSummary: { frequency: { code: 'once', label: 'Une fois' } },
    });

    // Agent : cleaning n'envoie aucun montant ; la gateway présente null, sans rien inventer.
    cleaning.stub.on('listVisits', async () => ({
      visits: [
        {
          ...protoVisit,
          requests: protoVisit.requests.map((item) => ({
            ...item,
            calculation: undefined,
            measurement: item.measurement && { ...item.measurement, calculation: undefined },
          })),
        },
      ],
      nextCursor: '',
    }));
    const forAgent = await backoffice(http().get('/api/v1/admin/cleaning/visits'), await agentToken());
    expect(forAgent.status).toBe(200);
    expect(forAgent.body.data[0].requests[0]).toMatchObject({
      answers: { rooms: 6 },
      measuredAnswers: { rooms: 8 },
      measuredSummary: { frequency: { code: 'once' } },
      calculation: null,
      measuredCalculation: null,
    });
  });

  // --- ADR-053 : compléments du Nettoyage ------------------------------------------------------------

  it('photos des passages : client propriétaire, agent et supervision ; corps et identifiants contrôlés', async () => {
    const mine = await http()
      .get(`/api/v1/cleaning/interventions/${IDS.intervention}/photos`)
      .set('Authorization', `Bearer ${customer}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data[0]).toMatchObject({
      kind: 'before',
      fileName: 'salon-avant.jpg',
      sizeBytes: 482113,
    });
    expect(cleaning.stub.last('listMyInterventionPhotos')!.request).toEqual({
      interventionId: IDS.intervention,
    });

    const agent = await agentToken();
    const url = `/api/v1/admin/cleaning/interventions/${IDS.intervention}/photos`;
    const fileId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d6101';
    const added = await backoffice(http().post(url), agent).send({ fileId, kind: 'after' });
    expect(added.status).toBe(200);
    expect(added.body.interventions[0]).toMatchObject({ changeReason: null });
    expect(cleaning.stub.last('addInterventionPhoto')!.request).toEqual({
      interventionId: IDS.intervention,
      fileId,
      kind: 'after',
    });
    expect((await backoffice(http().post(url), agent).send({ fileId, kind: 'pendant' })).status).toBe(400);
    expect((await backoffice(http().get(url), staff)).body.data).toHaveLength(1);
    expect((await backoffice(http().delete(`${url}/${fileId}`), agent)).status).toBe(200);
    expect(cleaning.stub.last('removeInterventionPhoto')!.request).toEqual({
      interventionId: IDS.intervention,
      fileId,
    });
    expect((await backoffice(http().delete(`${url}/pas-un-uuid`), agent)).status).toBe(400);
    cleaning.stub.on('addInterventionPhoto', () =>
      Promise.reject(
        AppError.precondition('CLEANING_PHOTO_LIMIT_REACHED', 'Trop.', { kind: 'after', maximum: 10 }),
      ),
    );
    expect((await backoffice(http().post(url), agent).send({ fileId, kind: 'after' })).status).toBe(422);
  });

  it('report et annulation pour replanifier : supervision seulement, motif obligatoire', async () => {
    const base = `/api/v1/admin/cleaning/interventions/${IDS.intervention}`;
    const moved = await backoffice(http().post(`${base}/reschedule`), staff).send({
      scheduledStart: '2026-11-07T08:00:00Z',
      reason: 'Client absent',
    });
    expect(moved.status).toBe(200);
    expect(cleaning.stub.last('rescheduleIntervention')!.request).toEqual({
      interventionId: IDS.intervention,
      scheduledStart: '2026-11-07T08:00:00Z',
      durationMinutes: 0,
      agentIds: [],
      teamId: '',
      reason: 'Client absent',
    });
    expect(
      (
        await backoffice(http().post(`${base}/reschedule`), staff).send({
          scheduledStart: '2026-11-07T08:00:00Z',
        })
      ).status,
    ).toBe(400);
    expect(
      (await backoffice(http().post(`${base}/unschedule`), await agentToken()).send({ reason: 'Pluie' }))
        .status,
    ).toBe(403);
    expect(
      (await backoffice(http().post(`${base}/unschedule`), staff).send({ reason: 'Pluie' })).status,
    ).toBe(200);
    expect(cleaning.stub.last('unscheduleIntervention')!.request).toEqual({
      interventionId: IDS.intervention,
      reason: 'Pluie',
    });
    // Contrat REST additif (ADR-053) : `unscheduled` est présenté en `manual` avec toReschedule.
    const cancelled = {
      ...protoMission.interventions[0]!,
      status: 'cancelled',
      cancellationCause: 'unscheduled',
    };
    cleaning.stub.on('unscheduleIntervention', async () => ({
      mission: { ...protoMission, interventions: [cancelled, { ...cancelled, cancellationCause: 'manual' }] },
    }));
    const res = await backoffice(http().post(`${base}/unschedule`), staff).send({ reason: 'Pluie' });
    expect(res.body.interventions[0]).toMatchObject({ cancellationCause: 'manual', toReschedule: true });
    expect(res.body.interventions[1].cancellationCause).toBe('manual');
    expect(res.body.interventions[1]).not.toHaveProperty('toReschedule');
  });

  it('agents et équipes : désactivation (409 avec la liste), indisponibilité forcée avec avertissement', async () => {
    const agents = `/api/v1/admin/cleaning/agents/${IDS.agent}`;
    expect((await backoffice(http().post(`${agents}/deactivate`), staff)).status).toBe(403);
    const off = await backoffice(http().post(`${agents}/deactivate`), admin);
    expect(off.body).toMatchObject({ agentId: IDS.agent, active: false });
    cleaning.stub.on('deactivateAgent', () =>
      Promise.reject(
        AppError.conflict('CLEANING_AGENT_HAS_ASSIGNMENTS', 'Affecté.', {
          assignments: [{ kind: 'intervention', id: IDS.intervention }],
        }),
      ),
    );
    const refused = await backoffice(http().post(`${agents}/deactivate`), admin);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.assignments).toHaveLength(1);
    expect((await backoffice(http().post(`${agents}/reactivate`), admin)).body.active).toBe(true);

    cleaning.stub.on('declareUnavailability', async () => ({
      agent: { agentId: IDS.agent, displayName: 'Awa B.', active: true, unavailabilities: [] },
      overlappingAssignments: [
        {
          kind: 'visit',
          id: IDS.visit,
          missionId: '',
          requestId: IDS.request,
          start: '2026-11-05T08:00:00.000Z',
          end: '2026-11-05T09:00:00.000Z',
        },
      ],
    }));
    const forced = await backoffice(http().post(`${agents}/unavailabilities`), admin).send({
      start: '2026-11-05T00:00:00Z',
      end: '2026-11-06T00:00:00Z',
      force: true,
    });
    expect(cleaning.stub.last('declareUnavailability')!.request).toMatchObject({ force: true });
    expect(forced.body.overlappingAssignments).toEqual([
      expect.objectContaining({ kind: 'visit', missionId: null, requestId: IDS.request }),
    ]);
    const unavailabilityId = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9001';
    expect(
      (await backoffice(http().delete(`${agents}/unavailabilities/${unavailabilityId}`), admin)).status,
    ).toBe(200);
    expect(cleaning.stub.last('removeUnavailability')!.request).toEqual({
      agentId: IDS.agent,
      unavailabilityId,
    });

    const teams = `/api/v1/admin/cleaning/teams/${IDS.team}`;
    expect((await backoffice(http().post(`${teams}/deactivate`), admin)).body).toMatchObject({
      active: false,
    });
    expect((await backoffice(http().post(`${teams}/reactivate`), admin)).body).toMatchObject({
      active: true,
    });
  });

  it('réglages des compléments : transmis, rappel absent laissé vide, bornes contrôlées', async () => {
    const settings = {
      quoteValidityDays: 15,
      minimumLeadHours: 48,
      freeCancellationHours: 24,
      maxOpenRequests: 5,
      depositPercent: 30,
    };
    const res = await backoffice(http().put('/api/v1/admin/cleaning/catalog/settings'), admin).send({
      ...settings,
      maxInterventionPhotos: 6,
    });
    expect(res.body).toMatchObject({
      quoteExpiryReminderDays: 2,
      maxInterventionPhotos: 10,
      visitDurationMinutes: 60,
    });
    const sent = cleaning.stub.last('updateSettings')!.request as { settings: Record<string, unknown> };
    expect(sent.settings).toMatchObject({ maxInterventionPhotos: 6, visitDurationMinutes: 0 });
    expect(sent.settings['quoteExpiryReminderDays']).toBeUndefined();
    await backoffice(http().put('/api/v1/admin/cleaning/catalog/settings'), admin).send({
      ...settings,
      quoteExpiryReminderDays: 0,
    });
    expect(cleaning.stub.last('updateSettings')!.request).toMatchObject({
      settings: { quoteExpiryReminderDays: 0 },
    });
    expect(
      (
        await backoffice(http().put('/api/v1/admin/cleaning/catalog/settings'), admin).send({
          ...settings,
          visitDurationMinutes: 5,
        })
      ).status,
    ).toBe(400);
  });
});
