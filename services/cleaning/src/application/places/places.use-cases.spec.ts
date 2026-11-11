import { type AppError } from '@ksp/platform';
import { gardenService } from '../../domain/testing';
import { SimulateUseCase } from '../catalog/catalog.use-cases';
import { SaveZoneUseCase } from '../catalog/zones.use-cases';
import { ListMissionsUseCase } from '../missions/admin-missions.use-cases';
import {
  CompleteVisitUseCase,
  ListQuoteRequestsUseCase,
  ScheduleVisitUseCase,
  SendQuoteUseCase,
} from '../requests/admin-requests.use-cases';
import { AcceptQuoteUseCase, CancelRequestUseCase } from '../requests/customer-requests.use-cases';
import {
  AGENT_ID,
  as,
  asAdmin,
  asCustomer,
  asSupervisor,
  CUSTOMER_ID,
  homeCleaning,
  ORGANIZATION_ID,
  OTHER_CUSTOMER_ID,
  placeType,
  testWorld,
  type TestWorld,
} from '../testing/fakes';
import { ResolveLocationUseCase } from './location.use-cases';
import {
  CatalogConsistencyUseCase,
  EstimateUseCase,
  GetPlaceCatalogUseCase,
  ListPlaceTypesUseCase,
  SavePlaceTypeUseCase,
} from './place-catalog.use-cases';
import {
  GetMyRequestGroupUseCase,
  ListGroupSiblingsUseCase,
  RequestQuoteGroupUseCase,
  type RequestQuoteGroupInput,
} from './request-groups.use-cases';
import { DescribeRequestsUseCase } from './request-labels.use-case';

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );
const details = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: AppError) => ({ code: error.code, ...(error.details as object) }),
  );

const SLOT = { start: '2026-10-30T08:00:00Z', end: '2026-10-30T11:00:00Z' };
/** Point fictif à Abomey-Calavi (aucun lieu réel). */
const POINT = { latitude: 6.4489, longitude: 2.3556, accuracyMeters: 15 };

const HOME = {
  serviceCode: 'home_cleaning',
  answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal' },
  optionSelections: [{ code: 'windows', answers: { window_count: 8 } }],
  frequency: 'once',
};
const GARDEN = {
  serviceCode: 'garden_maintenance',
  answers: { surface: 400, condition: 'maintained' },
  optionSelections: [],
  frequency: 'once',
};

function world(): TestWorld {
  const w = testWorld();
  w.catalog.services.set('home_cleaning', homeCleaning());
  w.catalog.services.set('garden_maintenance', gardenService());
  w.catalog.placeTypes.set('house', placeType({ serviceCodes: ['home_cleaning', 'garden_maintenance'] }));
  w.catalog.placeTypes.set(
    'apartment',
    placeType({ code: 'apartment', label: 'Appartement', displayOrder: 30, serviceCodes: ['home_cleaning'] }),
  );
  w.agents.agents.set(AGENT_ID, {
    agentId: AGENT_ID,
    displayName: 'Awa',
    active: true,
    unavailabilities: [],
  });
  return w;
}

function groupInput(overrides: Partial<RequestQuoteGroupInput> = {}): RequestQuoteGroupInput {
  return {
    idempotencyKey: 'grp-0001',
    placeType: 'house',
    location: POINT,
    landmark: 'Portail bleu, après la pharmacie',
    items: [HOME, GARDEN],
    preferredSlots: [SLOT],
    comment: 'Chien gentil',
    ...overrides,
  };
}

describe('parcours par lieu : catalogue et estimation (ADR-034)', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });

  it('catalogue public : lieux actifs triés, prestations actives référencées avec leur formulaire', async () => {
    w.catalog.placeTypes.set('office', placeType({ code: 'office', active: false, displayOrder: 1 }));
    w.catalog.services.set('garden_maintenance', gardenService({ active: false }));
    const catalog = await new GetPlaceCatalogUseCase(w).execute();
    expect(catalog.placeTypes.map((p) => [p.code, p.serviceCodes])).toEqual([
      ['house', ['home_cleaning']],
      ['apartment', ['home_cleaning']],
    ]);
    expect(catalog.services.map((s) => s.code)).toEqual(['home_cleaning']);
  });

  it('estimation sans commune : coefficient neutre, total des prestations, mention indicative', async () => {
    const result = await new EstimateUseCase(w).execute({ placeType: 'house', items: [HOME, GARDEN] });
    expect(result).toMatchObject({
      placeType: 'house',
      commune: null,
      communeApplied: false,
      covered: false,
      status: 'priced',
      total: 34_000 + 60_000,
    });
    expect(result.items.map((item) => [item.service.code, item.calculation.computedPrice])).toEqual([
      ['home_cleaning', 34_000],
      ['garden_maintenance', 60_000],
    ]);
    expect(result.notice).toContain('sans commune');
  });

  it('estimation avec commune : coefficient appliqué ; prestation sans prix : total absent', async () => {
    const withCommune = await new EstimateUseCase(w).execute({
      placeType: 'house',
      commune: 'Abomey-Calavi',
      items: [HOME],
    });
    expect(withCommune).toMatchObject({ communeApplied: true, covered: true, total: 35_700 });
    w.catalog.services.set(
      'garden_maintenance',
      gardenService({ fields: gardenService().fields.map((f) => ({ ...f, pricePerUnit: null })) }),
    );
    const partial = await new EstimateUseCase(w).execute({ placeType: 'house', items: [HOME, GARDEN] });
    expect(partial).toMatchObject({ status: 'partially_priced', total: null });
    expect(partial.items[1]!.calculation).toMatchObject({ priced: false, reason: 'price_not_set' });
  });

  it('refuse un lieu inconnu, une prestation non proposée, en double, une réponse invalide', async () => {
    const estimate = (input: Parameters<EstimateUseCase['execute']>[0]) =>
      new EstimateUseCase(w).execute(input);
    expect(await code(estimate({ placeType: 'castle', items: [HOME] }))).toBe(
      'CLEANING_PLACE_TYPE_NOT_FOUND',
    );
    expect(await details(estimate({ placeType: 'apartment', items: [GARDEN] }))).toEqual({
      code: 'CLEANING_SERVICE_NOT_OFFERED',
      field: 'items[0].serviceCode',
      placeType: 'apartment',
      serviceCode: 'garden_maintenance',
    });
    expect(await details(estimate({ placeType: 'house', items: [HOME, HOME] }))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      field: 'items[1].serviceCode',
    });
    expect(
      await details(estimate({ placeType: 'house', items: [HOME, { ...GARDEN, answers: { surface: 0 } }] })),
    ).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      field: 'items[1].answers.surface',
      reason: 'out_of_range',
    });
    expect(await details(estimate({ placeType: 'house', items: [] }))).toMatchObject({ field: 'items' });
  });

  it('simulation simple sans commune : prix indicatif signalé, ancien format inchangé', async () => {
    const result = await new SimulateUseCase(w).execute({ ...HOME, optionSelections: HOME.optionSelections });
    expect(result).toMatchObject({ communeApplied: false, covered: false });
    expect(result.calculation.computedPrice).toBe(34_000);
    const legacy = await new SimulateUseCase(w).execute({
      serviceCode: 'home_cleaning',
      premisesType: 'house',
      quantity: 6,
      commune: 'Abomey-Calavi',
    });
    expect(legacy).toMatchObject({ communeApplied: true, covered: true });
  });
});

describe('parcours par lieu : position (ADR-034)', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });

  it('commune trouvée et desservie ; fournisseur et adresse lisible', async () => {
    const result = await asCustomer(() => new ResolveLocationUseCase(w).execute(POINT));
    expect(result).toEqual({
      latitude: POINT.latitude,
      longitude: POINT.longitude,
      commune: 'Abomey-Calavi',
      zoneCode: 'abomey-calavi',
      served: true,
      displayAddress: 'Zogbadjè, Abomey-Calavi, Atlantique, Bénin',
      provider: 'nominatim',
    });
  });

  it('commune hors zone, aucun résultat, panne : réponse sans erreur ; nom alternatif reconnu', async () => {
    w.geocoder.result = { provider: 'google', communes: ['Parakou', 'Borgou'], displayAddress: null };
    expect(await asCustomer(() => new ResolveLocationUseCase(w).execute(POINT))).toMatchObject({
      commune: 'Parakou',
      zoneCode: null,
      served: false,
      provider: 'google',
    });
    w.geocoder.result = null;
    expect(await asCustomer(() => new ResolveLocationUseCase(w).execute(POINT))).toMatchObject({
      commune: null,
      provider: null,
      served: false,
    });
    w.geocoder.failure = new Error('panne');
    expect(await asCustomer(() => new ResolveLocationUseCase(w).execute(POINT))).toMatchObject({
      provider: null,
    });
    w.geocoder.failure = null;
    await asAdmin(() => new SaveZoneUseCase(w).execute({ commune: 'Sèmè-Podji', aliases: ['Sèmè-Kpodji'] }));
    w.geocoder.result = { provider: 'nominatim', communes: ['Commune de Sèmè-Kpodji'], displayAddress: null };
    expect(await asCustomer(() => new ResolveLocationUseCase(w).execute(POINT))).toMatchObject({
      commune: 'Sèmè-Podji',
      zoneCode: 'seme-podji',
      served: true,
    });
  });

  it('client connecté seulement ; coordonnées hors bornes refusées', async () => {
    expect(await code(new ResolveLocationUseCase(w).execute(POINT))).toBe('AUTH_REQUIRED');
    expect(
      await details(asCustomer(() => new ResolveLocationUseCase(w).execute({ latitude: 95, longitude: 2 }))),
    ).toMatchObject({ code: 'CLEANING_VALIDATION_FAILED', field: 'latitude' });
    expect(
      await details(asCustomer(() => new ResolveLocationUseCase(w).execute({ latitude: 6, longitude: 181 }))),
    ).toMatchObject({ field: 'longitude' });
  });
});

describe('parcours par lieu : groupe de demandes (ADR-034)', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });
  const create = (overrides: Partial<RequestQuoteGroupInput> = {}, userId = CUSTOMER_ID) =>
    asCustomer(() => new RequestQuoteGroupUseCase(w).execute(groupInput(overrides)), userId);

  it('une demande par prestation, liées, dans une transaction ; un événement par demande et un pour le groupe', async () => {
    const view = await create();
    expect(view.group).toMatchObject({
      placeType: 'house',
      commune: 'Abomey-Calavi',
      customerId: CUSTOMER_ID,
    });
    expect(view.requests.map((r) => r.serviceCode)).toEqual(['home_cleaning', 'garden_maintenance']);
    for (const request of view.requests) {
      expect(request).toMatchObject({
        status: 'received',
        groupId: view.group.id,
        placeType: 'house',
        location: POINT,
        landmark: 'Portail bleu, après la pharmacie',
        address: 'Portail bleu, après la pharmacie',
        geocodingProvider: 'nominatim',
        geocodedAddress: 'Zogbadjè, Abomey-Calavi, Atlantique, Bénin',
        commune: 'Abomey-Calavi',
        preferredSlots: [{ start: new Date(SLOT.start), end: new Date(SLOT.end) }],
        comment: 'Chien gentil',
      });
    }
    // Prix recalculé avec la vraie commune (coefficient d'Abomey-Calavi : 1,05).
    expect(view.requests[0]!.calculation).toMatchObject({ priced: true, computedPrice: 35_700 });
    expect(w.recorder.changes).toHaveLength(1);
    const serviceName = (code: string) => w.catalog.services.get(code)!.name;
    expect(w.recorder.events).toEqual([
      ...view.requests.map((request) => ({
        type: 'cleaning.quote.requested',
        payload: {
          requestId: request.id,
          customerId: CUSTOMER_ID,
          organizationId: null,
          customerKind: 'individual',
          serviceCode: request.serviceCode,
          serviceName: serviceName(request.serviceCode),
          visitRequired: true,
          groupId: view.group.id,
          summarizedByGroup: true,
        },
      })),
      // Un seul message au client pour l'envoi groupé (ADR-035 point 14).
      {
        type: 'cleaning.quote_group.requested',
        payload: {
          groupId: view.group.id,
          customerId: CUSTOMER_ID,
          organizationId: null,
          customerKind: 'individual',
          visitRequired: true,
          requests: view.requests.map((request) => ({
            requestId: request.id,
            serviceCode: request.serviceCode,
            serviceName: serviceName(request.serviceCode),
          })),
        },
      },
    ]);
    expect(w.recorder.audit.map((entry) => entry.action)).toEqual([
      'request.created',
      'request.created',
      'request_group.created',
    ]);
    expect(w.recorder.audit[0]!.details).toMatchObject({ groupId: view.group.id });
    // Ni position, ni repère, ni commentaire dans les événements et le journal.
    const written = JSON.stringify(w.recorder.changes);
    expect(written).not.toContain('Portail bleu');
    expect(written).not.toContain('6.4489');
    expect(written).not.toContain('Chien gentil');
  });

  it('idempotence : la même clé rend le même groupe sans rien réécrire', async () => {
    const first = await create();
    const second = await create({ items: [HOME] });
    expect(second.group.id).toBe(first.group.id);
    expect(second.requests).toHaveLength(2);
    expect(w.requests.requests.size).toBe(2);
    expect(w.recorder.events).toHaveLength(3);
  });

  it('transaction : un échec d’écriture ne laisse aucune demande', async () => {
    w.requests.failGroupWrites = true;
    await expect(create()).rejects.toThrow('transaction annulée');
    expect(w.requests.requests.size).toBe(0);
    expect(w.recorder.changes).toHaveLength(0);
  });

  it('la commune envoyée est ignorée quand le géocodage réussit ; hors zone : refus', async () => {
    const view = await create({ commune: 'Cotonou' });
    expect(view.group.commune).toBe('Abomey-Calavi');
    w.geocoder.result = { provider: 'google', communes: ['Parakou'], displayAddress: null };
    expect(await details(create({ idempotencyKey: 'grp-0002', commune: 'Cotonou' }))).toEqual({
      code: 'CLEANING_ZONE_NOT_COVERED',
      commune: 'Parakou',
    });
  });

  it('géocodage sans résultat : repli sur la commune choisie, contrôlée ; sans elle : à demander', async () => {
    w.geocoder.result = null;
    const view = await create({ commune: 'cotonou' });
    expect(view.group.commune).toBe('Cotonou');
    expect(view.requests[0]).toMatchObject({
      commune: 'Cotonou',
      geocodingProvider: null,
      geocodedAddress: null,
    });
    expect(await code(create({ idempotencyKey: 'grp-0003' }))).toBe('CLEANING_LOCATION_UNRESOLVED');
    expect(await code(create({ idempotencyKey: 'grp-0004', commune: 'Parakou' }))).toBe(
      'CLEANING_ZONE_NOT_COVERED',
    );
    w.geocoder.failure = new Error('panne');
    expect((await create({ idempotencyKey: 'grp-0005', commune: 'Abomey-Calavi' })).group.commune).toBe(
      'Abomey-Calavi',
    );
  });

  it('refuse une prestation non proposée, un repère manquant, une position hors bornes', async () => {
    expect(await details(create({ placeType: 'apartment' }))).toMatchObject({
      code: 'CLEANING_SERVICE_NOT_OFFERED',
      field: 'items[1].serviceCode',
    });
    expect(await details(create({ landmark: ' ' }))).toMatchObject({ field: 'landmark' });
    expect(await details(create({ location: { latitude: 6.4, longitude: 200 } }))).toMatchObject({
      field: 'longitude',
    });
    expect(await details(create({ location: undefined }))).toMatchObject({ field: 'location' });
    expect(await code(create({ placeType: 'castle' }))).toBe('CLEANING_PLACE_TYPE_NOT_FOUND');
    expect(w.requests.requests.size).toBe(0);
  });

  it('organisation suspendue : refusée ; client entreprise : demandes à son nom', async () => {
    const asBusiness = () =>
      as(CUSTOMER_ID, () => new RequestQuoteGroupUseCase(w).execute(groupInput()), {
        activeContext: ORGANIZATION_ID,
        orgRole: 'org_member',
      });
    const view = await asBusiness();
    expect(view.requests.every((r) => r.organizationId === ORGANIZATION_ID)).toBe(true);
    await w.organizations.record({
      eventId: 'e1',
      consumer: 'c',
      organizationId: ORGANIZATION_ID,
      suspended: true,
      at: new Date(),
    });
    expect(
      await code(
        as(
          CUSTOMER_ID,
          () => new RequestQuoteGroupUseCase(w).execute(groupInput({ idempotencyKey: 'grp-9' })),
          {
            activeContext: ORGANIZATION_ID,
            orgRole: 'org_member',
          },
        ),
      ),
    ).toBe('CLEANING_ORGANIZATION_SUSPENDED');
  });

  it('le propriétaire voit son groupe ; un autre client : 404', async () => {
    const view = await create();
    const found = await asCustomer(() => new GetMyRequestGroupUseCase(w).execute(view.group.id));
    expect(found.requests.map((r) => r.id)).toEqual(view.requests.map((r) => r.id));
    expect(
      await code(asCustomer(() => new GetMyRequestGroupUseCase(w).execute(view.group.id), OTHER_CUSTOMER_ID)),
    ).toBe('CLEANING_REQUEST_GROUP_NOT_FOUND');
  });

  it('chaque demande suit son circuit : visite, devis, acceptation ; mission avec position et groupe', async () => {
    const view = await create();
    const [home, garden] = view.requests;
    const visited = await asSupervisor(() =>
      new ScheduleVisitUseCase(w).execute({
        requestId: home!.id,
        scheduledAt: '2026-10-26T09:00:00Z',
        agentId: AGENT_ID,
      }),
    );
    w.clock.current = new Date('2026-10-26T11:00:00Z');
    await asSupervisor(() =>
      new CompleteVisitUseCase(w).execute({ visitId: visited.visit!.id, report: 'ok' }),
    );
    w.clock.current = new Date('2026-10-23T08:00:00Z');
    await asSupervisor(() =>
      new SendQuoteUseCase(w).execute({
        requestId: home!.id,
        lines: [],
        proposedSlots: [SLOT],
        validityDays: 0,
        teamSize: 0,
        durationMinutes: 180,
      }),
    );
    const accepted = await asCustomer(() =>
      new AcceptQuoteUseCase(w).execute({
        requestId: home!.id,
        idempotencyKey: 'acc-1',
        slotStart: SLOT.start,
        paymentPlan: { option: 'full', timing: 'after', method: 'cash' },
      }),
    );
    expect(accepted.mission.mission).toMatchObject({
      location: POINT,
      landmark: 'Portail bleu, après la pharmacie',
      groupId: view.group.id,
      placeType: 'house',
    });
    await asCustomer(() => new CancelRequestUseCase(w).execute({ requestId: garden!.id, reason: '' }));

    // Événements : prestation, nom et groupe en champs facultatifs.
    const subject = {
      serviceCode: 'home_cleaning',
      serviceName: 'Nettoyage à domicile',
      groupId: view.group.id,
    };
    for (const type of ['cleaning.visit.scheduled', 'cleaning.quote.sent', 'cleaning.booking.confirmed']) {
      expect(w.recorder.events.find((event) => event.type === type)?.payload).toMatchObject(subject);
    }
    expect(
      w.recorder.events.find((event) => event.type === 'cleaning.request.cancelled')?.payload,
    ).toMatchObject({
      serviceCode: 'garden_maintenance',
      serviceName: 'Entretien de jardin',
      groupId: view.group.id,
    });

    // Back-office : demandes sœurs, filtres et libellés.
    const siblings = await asSupervisor(() => new ListGroupSiblingsUseCase(w).execute(home!));
    expect(siblings.map((s) => [s.serviceCode, s.status])).toEqual([['garden_maintenance', 'cancelled']]);
    const missions = await asSupervisor(() =>
      new ListMissionsUseCase(w).execute({
        page: { limit: 10, cursor: null },
        status: '',
        groupId: view.group.id,
        serviceCode: 'home_cleaning',
      }),
    );
    expect(missions.items).toHaveLength(1);
    const listed = await asSupervisor(() =>
      new ListQuoteRequestsUseCase(w).execute({
        page: { limit: 10, cursor: null },
        status: '',
        groupId: view.group.id,
        placeType: 'house',
        serviceCode: 'garden_maintenance',
      }),
    );
    expect(listed.items.map((r) => r.id)).toEqual([garden!.id]);
    const labels = await new DescribeRequestsUseCase(w).execute(view.requests);
    expect(labels.groupSizes.get(view.group.id)).toBe(2);
    expect(labels.serviceNames.get('garden_maintenance')).toBe('Entretien de jardin');
    expect(labels.placeTypeLabels.get('house')).toBe('Maison');
    expect(
      await asSupervisor(() => new ListGroupSiblingsUseCase(w).execute({ id: 'x', groupId: null })),
    ).toEqual([]);
  });

  it('plafond des demandes ouvertes : un groupe compte pour 1, ouvert tant qu’une demande l’est (ADR-035)', async () => {
    w.catalog.settings = { ...w.catalog.settings, maxOpenRequests: 1 };
    const view = await create();
    expect(view.requests).toHaveLength(2);
    expect(await w.requests.countOpen(CUSTOMER_ID, w.clock.now())).toBe(1);
    expect(await code(create({ idempotencyKey: 'grp-0002' }))).toBe('CLEANING_TOO_MANY_OPEN_REQUESTS');
    // Une demande encore ouverte garde le groupe ouvert.
    await asCustomer(() =>
      new CancelRequestUseCase(w).execute({ requestId: view.requests[0]!.id, reason: '' }),
    );
    expect(await w.requests.countOpen(CUSTOMER_ID, w.clock.now())).toBe(1);
    await asCustomer(() =>
      new CancelRequestUseCase(w).execute({ requestId: view.requests[1]!.id, reason: '' }),
    );
    expect(await w.requests.countOpen(CUSTOMER_ID, w.clock.now())).toBe(0);
    expect(await code(create({ idempotencyKey: 'grp-0003' }))).toBe('ok');
  });
});

describe('types de lieu au back-office (ADR-034)', () => {
  let w: TestWorld;
  beforeEach(() => {
    w = world();
  });
  const save = (overrides: Record<string, unknown> = {}) =>
    asAdmin(() =>
      new SavePlaceTypeUseCase(w).execute({
        code: 'house',
        label: 'Maison',
        description: 'Maison individuelle',
        icon: 'house',
        displayOrder: 10,
        active: true,
        serviceCodes: ['home_cleaning', 'garden_maintenance'],
        ...overrides,
      }),
    );

  it('crée ou modifie, trace la différence des prestations, refuse une prestation inconnue', async () => {
    const view = await save({ serviceCodes: ['garden_maintenance'] });
    expect(view.placeType).toMatchObject({ code: 'house', serviceCodes: ['garden_maintenance'] });
    expect(view.health).toMatchObject({ publiclyVisible: true });
    expect(w.recorder.audit.at(-1)).toMatchObject({
      action: 'place_type.saved',
      entityType: 'place_type',
      entityId: 'house',
      details: { created: false, added: [], removed: ['home_cleaning'] },
    });
    expect(await details(save({ serviceCodes: ['home_cleaning', 'jacuzzi_cleaning'] }))).toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      field: 'serviceCodes[1]',
    });
    expect(await details(save({ code: 'Villa!' }))).toMatchObject({ field: 'code' });
  });

  it('prestation inactive acceptée mais masquée ; cohérence et visibilité listées', async () => {
    w.catalog.services.set('garden_maintenance', gardenService({ active: false }));
    await save({ code: 'garden', label: 'Jardin', serviceCodes: ['garden_maintenance'] });
    const views = await asAdmin(() => new ListPlaceTypesUseCase(w).execute());
    expect(views.map((v) => [v.placeType.code, v.health.publiclyVisible, v.health.visibilityReason])).toEqual(
      [
        ['garden', false, 'no_active_service'],
        ['house', true, null],
        ['apartment', true, null],
      ],
    );
    const consistency = new CatalogConsistencyUseCase(w);
    expect(
      (await asAdmin(() => consistency.placeTypesOffering('garden_maintenance'))).map((p) => p.code),
    ).toEqual(['garden', 'house']);
    w.catalog.services.set('pest_control', gardenService({ code: 'pest_control' }));
    expect(await asAdmin(async () => consistency.unplacedServices(await w.catalog.listServices()))).toEqual([
      'pest_control',
    ]);
  });

  it('rôle d’administration et double authentification exigés', async () => {
    expect(await code(asSupervisor(() => new ListPlaceTypesUseCase(w).execute()))).toBe('AUTH_FORBIDDEN');
    expect(await code(asCustomer(() => new SavePlaceTypeUseCase(w).execute({} as never)))).toBe(
      'AUTH_FORBIDDEN',
    );
  });

  it('zones : noms alternatifs gardés si absents, remplacés si présents, doublon refusé', async () => {
    const first = await asAdmin(() =>
      new SaveZoneUseCase(w).execute({ commune: 'Sèmè-Podji', aliases: ['Sèmè-Kpodji'] }),
    );
    expect(first.zone.aliases).toEqual(['Sèmè-Kpodji']);
    const kept = await asAdmin(() => new SaveZoneUseCase(w).execute({ commune: 'Sèmè-Podji' }));
    expect(kept.zone.aliases).toEqual(['Sèmè-Kpodji']);
    const cleared = await asAdmin(() =>
      new SaveZoneUseCase(w).execute({ commune: 'Sèmè-Podji', aliases: [] }),
    );
    expect(cleared.zone.aliases).toEqual([]);
    expect(
      await details(
        asAdmin(() => new SaveZoneUseCase(w).execute({ commune: 'Sèmè-Podji', aliases: ['Sèmè Podji'] })),
      ),
    ).toMatchObject({ field: 'aliases[0]' });
  });
});
