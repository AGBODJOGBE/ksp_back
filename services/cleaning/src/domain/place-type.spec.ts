import { aggregateEstimates } from './estimate';
import { communeKey, isValidAccuracy, isValidPoint, matchCommune } from './location';
import {
  offersService,
  type PlaceType,
  placeTypeHealth,
  placeTypeProblems,
  placeTypesOffering,
  publicPlaceCatalog,
  serviceCodesChange,
  unplacedServiceCodes,
} from './place-type';
import { calculatePrice } from './simulator';
import { gardenService, homeCleaningService } from './testing';
import { isCovered, type Zone } from './zone';

const place = (overrides: Partial<PlaceType> = {}): PlaceType => ({
  code: 'house',
  label: 'Maison',
  description: '',
  icon: 'house',
  displayOrder: 10,
  active: true,
  serviceCodes: ['home_cleaning', 'garden_maintenance'],
  updatedBy: null,
  updatedAt: null,
  ...overrides,
});

const zone = (commune: string, code: string, extra: Partial<Zone> = {}): Zone => ({
  code,
  commune,
  aliases: [],
  active: true,
  updatedBy: null,
  updatedAt: null,
  ...extra,
});

describe('types de lieu (ADR-034)', () => {
  it('contrôle du code, du libellé, de l’icône, de l’ordre et des prestations', () => {
    const draft = place();
    expect(placeTypeProblems(draft)).toEqual([]);
    expect(placeTypeProblems({ ...draft, code: 'Maison' })).toEqual(['code']);
    expect(placeTypeProblems({ ...draft, label: ' ' })).toEqual(['label']);
    expect(placeTypeProblems({ ...draft, icon: '' })).toEqual(['icon']);
    expect(placeTypeProblems({ ...draft, displayOrder: -1 })).toEqual(['displayOrder']);
    expect(placeTypeProblems({ ...draft, displayOrder: 1.5 })).toEqual(['displayOrder']);
    expect(placeTypeProblems({ ...draft, serviceCodes: ['home_cleaning', 'home_cleaning'] })).toEqual([
      'serviceCodes[1]',
    ]);
    expect(placeTypeProblems({ ...draft, serviceCodes: [] })).toEqual([]);
    expect(offersService(draft, 'garden_maintenance')).toBe(true);
    expect(offersService(draft, 'office_cleaning')).toBe(false);
  });

  it('catalogue public : lieux actifs triés, prestations actives seulement, lieu vide masqué', () => {
    const garden = gardenService({ active: false });
    const catalog = publicPlaceCatalog(
      [
        place({ code: 'villa', label: 'Villa', displayOrder: 20 }),
        place({ code: 'office', displayOrder: 5, serviceCodes: ['garden_maintenance', 'unknown_service'] }),
        place({ code: 'site', active: false, displayOrder: 1 }),
        place({ displayOrder: 20 }),
      ],
      [homeCleaningService(), garden],
    );
    expect(catalog.placeTypes.map((p) => [p.code, p.serviceCodes])).toEqual([
      ['house', ['home_cleaning']],
      ['villa', ['home_cleaning']],
    ]);
    expect(catalog.services.map((s) => s.code)).toEqual(['home_cleaning']);
  });

  it('cohérence : prestations inconnues ou inactives, visibilité et sa raison', () => {
    const services = [homeCleaningService(), gardenService({ active: false })];
    expect(
      placeTypeHealth(place({ serviceCodes: ['home_cleaning', 'garden_maintenance', 'x_y'] }), services),
    ).toEqual({
      unknownServiceCodes: ['x_y'],
      inactiveServiceCodes: ['garden_maintenance'],
      publiclyVisible: true,
      visibilityReason: null,
    });
    expect(placeTypeHealth(place({ serviceCodes: ['garden_maintenance'] }), services)).toMatchObject({
      publiclyVisible: false,
      visibilityReason: 'no_active_service',
    });
    expect(placeTypeHealth(place({ active: false }), services)).toMatchObject({
      publiclyVisible: false,
      visibilityReason: 'inactive',
    });
    const placeTypes = [
      place(),
      place({ code: 'villa', active: false }),
      place({ code: 'flat', serviceCodes: [] }),
    ];
    expect(placeTypesOffering(placeTypes, 'garden_maintenance').map((p) => p.code)).toEqual(['house']);
    expect(unplacedServiceCodes([...services, gardenService({ code: 'pest_control' })], placeTypes)).toEqual([
      'pest_control',
    ]);
    expect(serviceCodesChange(['a_b', 'c_d'], ['c_d', 'e_f'])).toEqual({ added: ['e_f'], removed: ['a_b'] });
  });
});

describe('position et commune (ADR-034)', () => {
  it('bornes des coordonnées et de la précision', () => {
    expect(isValidPoint({ latitude: 6.3703, longitude: 2.3912 })).toBe(true);
    expect(isValidPoint({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidPoint({ latitude: 0, longitude: -180.5 })).toBe(false);
    expect(isValidPoint({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(isValidAccuracy(null)).toBe(true);
    expect(isValidAccuracy(12.5)).toBe(true);
    expect(isValidAccuracy(-1)).toBe(false);
    expect(isValidAccuracy(200_000)).toBe(false);
  });

  it('nom du fournisseur normalisé comme Zone.code, préfixe administratif retiré', () => {
    expect(communeKey('Abomey-Calavi')).toBe('abomey-calavi');
    expect(communeKey('Commune d’Abomey-Calavi')).toBe('abomey-calavi');
    expect(communeKey('Commune de Sèmè-Podji')).toBe('seme-podji');
    expect(communeKey('  COTONOU ')).toBe('cotonou');
  });

  it('première commune desservie l’emporte, noms alternatifs compris ; sinon la première trouvée', () => {
    const zones = [
      zone('Cotonou', 'cotonou'),
      zone('Sèmè-Podji', 'seme-podji', { aliases: ['Sèmè-Kpodji'] }),
      zone('Porto-Novo', 'porto-novo', { active: false }),
    ];
    expect(matchCommune(['Atlantique', 'Cotonou'], zones)).toEqual({ commune: 'Cotonou', zone: zones[0] });
    expect(matchCommune(['Sèmè-Kpodji'], zones)).toEqual({ commune: 'Sèmè-Podji', zone: zones[1] });
    expect(matchCommune(['Porto-Novo', 'Ouémé'], zones)).toEqual({ commune: 'Porto-Novo', zone: null });
    expect(matchCommune([' ', ''], zones)).toBeNull();
    expect(isCovered(zones, 'Sèmè Kpodji')).toBe(true);
    expect(isCovered(zones, 'Porto-Novo')).toBe(false);
  });
});

describe('estimation de plusieurs prestations (ADR-034)', () => {
  const answers = {
    answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal' },
    options: [{ code: 'windows', answers: { window_count: 8 } }],
    frequency: 'once',
  };

  it('sans commune : coefficient neutre, aucune ligne de commune', () => {
    const service = homeCleaningService();
    const without = calculatePrice(service, { ...answers, commune: null });
    const withCommune = calculatePrice(service, { ...answers, commune: 'Abomey-Calavi' });
    expect(without).toMatchObject({ priced: true, subtotal: 34_000, computedPrice: 34_000 });
    expect(without.coefficients.some((c) => c.source === 'commune')).toBe(false);
    expect(withCommune.computedPrice).toBe(35_700);
  });

  it('total si toutes les prestations ont un prix, sinon statut partiel ou sans prix', () => {
    expect(
      aggregateEstimates([
        { priced: true, computedPrice: 35_700 },
        { priced: true, computedPrice: 60_000 },
      ]),
    ).toEqual({ status: 'priced', total: 95_700 });
    expect(
      aggregateEstimates([
        { priced: true, computedPrice: 35_700 },
        { priced: false, computedPrice: null },
      ]),
    ).toEqual({ status: 'partially_priced', total: null });
    expect(aggregateEstimates([{ priced: false, computedPrice: null }])).toEqual({
      status: 'unpriced',
      total: null,
    });
    expect(aggregateEstimates([])).toEqual({ status: 'unpriced', total: null });
  });
});
