import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { type CleaningServer, IDS, protoMission, startCleaningStub } from './support/cleaning-stub';
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
    app = await startGateway({ identityUrl: identity.url, cleaningUrl: cleaning.url, keys });
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
    expect(cleaning.stub.last('deactivateZone')!.request).toEqual({ code: 'abomey-calavi' });
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
});
