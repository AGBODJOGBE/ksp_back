import { TariffsUseCases } from '../catalog/tariffs.use-cases';
import { asStaff, CatalogMemory } from '../testing/catalog-fakes';
import { type MaisonCatalog, seedMaison, SOL_TARIFF, VITRES_TARIFF } from '../testing/catalog-fixtures';
import { PreviewScheduleUseCase, SimulateUseCase, SimulateWithDraftsUseCase } from './simulate.use-cases';

/** Programme de l'exemple : chaque semaine (le lundi), 12 semaines. */
export const WEEKLY_12 = {
  kind: 'weekly',
  startTime: '08:00',
  dates: [],
  weekdays: ['mon'],
  monthDays: [],
  monthWeekdays: [],
  startDate: '2027-01-04',
  durationWeeks: 12,
  excludedDates: [],
  addedDates: [],
};

const VILLA = { superficie: 120, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 };

async function published() {
  const memory = new CatalogMemory();
  const catalog = seedMaison(memory);
  const deps = memory.deps();
  const tariffs = new TariffsUseCases(deps);
  for (const [offerId, tariff, key] of [
    [catalog.solOfferId, SOL_TARIFF, 'cle-sol-0001'],
    [catalog.vitresOfferId, VITRES_TARIFF, 'cle-vitres-01'],
  ] as const) {
    await asStaff(() => tariffs.createDraft({ ...tariff, offerId, idempotencyKey: key }));
    await asStaff(() => tariffs.publish({ offerId, version: 1, idempotencyKey: `${key}-p` }));
  }
  return { memory, catalog, deps, simulate: new SimulateUseCase(deps) };
}

const request = (catalog: MaisonCatalog, patch: object = {}) => ({
  placeTypeId: catalog.placeTypeId,
  cleaningTypeIds: [catalog.solTypeId, catalog.vitresTypeId],
  values: VILLA,
  schedule: WEEKLY_12,
  communeKey: 'cotonou',
  ...patch,
});

describe('UC-NT-01 — simulateur public (partie 5)', () => {
  it('exemple de la partie 5 au franc près : 32 040 FCFA la séance, 384 480 FCFA le programme', async () => {
    const { catalog, simulate } = await published();
    const result = await simulate.execute(request(catalog));
    expect(result.pricing).toMatchObject({
      status: 'priced',
      covered: true,
      communeKey: 'cotonou',
      sessionPrice: 32_040,
      sessionsCount: 12,
      programTotal: 384_480,
      range: { low: 28_500, high: 37_000 },
      frequencyDiscount: 3560,
      teamSize: 3,
      durationMinutes: 300,
      notices: [],
      usesDrafts: false,
    });
    expect(result.pricing.offers.map((offer) => [offer.name, offer.price, offer.tariffVersion])).toEqual([
      ['Sol', 26_640, 1],
      ['Vitres', 5400, 1],
    ]);
    expect(result.pricing.offers[0]?.lines.map((line) => [line.label, line.amount])).toEqual([
      ['Sol, tranche 51 à 150 m²', 21_600],
      ['Sol, supplément cour', 5000],
      ['Sol, chambres au-delà de 3', 3000],
      ['Sol, remise récurrente', -2960],
    ]);
    expect(result).toMatchObject({
      visitFee: 5000,
      disclaimer: 'Estimation non contractuelle, confirmée après la visite des lieux',
      schedule: { count: 12 },
    });
  });

  it('sans commune : coefficient neutre ; offre sans tarif publié : prix partiel', async () => {
    const { memory, catalog, simulate } = await published();
    const visitor = await simulate.execute(request(catalog, { communeKey: undefined, schedule: undefined }));
    expect(visitor.pricing).toMatchObject({ covered: false, notices: ['no_commune'], sessionPrice: 35_600 });
    for (const tariff of memory.tariffs.values())
      if (tariff.offerId === catalog.vitresOfferId) tariff.status = 'archived';
    const partial = await simulate.execute(request(catalog, { communeKey: 'parakou' }));
    expect(partial.pricing).toMatchObject({
      status: 'partially_priced',
      sessionPrice: null,
      pricedSubtotal: 26_640,
      notices: ['commune_not_covered', 'partially_priced'],
    });
    expect(partial.pricing.offers[1]).toMatchObject({
      status: 'on_quote',
      onQuoteReason: 'no_published_tariff',
    });
  });

  it('refuse un lieu inconnu ou masqué, un type non proposé, une valeur hors bornes', async () => {
    const { memory, catalog, simulate } = await published();
    await expect(simulate.execute(request(catalog, { placeTypeId: 'x' }))).rejects.toMatchObject({
      code: 'CLEANING_PLACE_TYPE_NOT_FOUND',
    });
    await expect(simulate.execute(request(catalog, { cleaningTypeIds: ['x'] }))).rejects.toMatchObject({
      code: 'CLEANING_OFFER_NOT_AVAILABLE',
      details: { cleaningTypeId: 'x' },
    });
    await expect(simulate.execute(request(catalog, { cleaningTypeIds: [] }))).rejects.toMatchObject({
      details: { field: 'cleaningTypeIds', reason: 'required' },
    });
    await expect(
      simulate.execute(request(catalog, { values: { ...VILLA, superficie: 6000 } })),
    ).rejects.toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'values.superficie', reason: 'out_of_range' },
    });
    await expect(
      simulate.execute(request(catalog, { values: { ...VILLA, piscine: true } })),
    ).rejects.toMatchObject({
      details: { field: 'values.piscine', reason: 'unknown_parameter' },
    });
    await expect(
      simulate.execute(request(catalog, { values: { ...VILLA, cour: null } })),
    ).rejects.toMatchObject({
      details: { field: 'values.cour', reason: 'invalid_type' },
    });
    (memory.offers.get(catalog.vitresOfferId) as { active: boolean }).active = false;
    await expect(simulate.execute(request(catalog))).rejects.toMatchObject({
      code: 'CLEANING_OFFER_NOT_AVAILABLE',
    });
    (memory.placeTypes.get(catalog.placeTypeId) as { active: boolean }).active = false;
    await expect(simulate.execute(request(catalog))).rejects.toMatchObject({
      code: 'CLEANING_PLACE_TYPE_NOT_FOUND',
    });
  });

  it('lieu « Autre » : pas de simulation ; programme vide ou trop long refusé', async () => {
    const { memory, catalog, simulate } = await published();
    memory.settings.programMaxSessions = 5;
    await expect(simulate.execute(request(catalog))).rejects.toMatchObject({
      code: 'CLEANING_SCHEDULE_LIMIT_EXCEEDED',
      details: { maxMonths: 24, maxSessions: 5 },
    });
    await expect(
      simulate.execute(
        request(catalog, {
          schedule: {
            ...WEEKLY_12,
            excludedDates: [],
            kind: 'one_off',
            weekdays: [],
            startDate: undefined,
            durationWeeks: undefined,
            dates: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ details: { field: 'schedule.dates', reason: 'required' } });
    await expect(
      simulate.execute(request(catalog, { schedule: { ...WEEKLY_12, kind: 'daily' } })),
    ).rejects.toMatchObject({
      details: { field: 'schedule.kind', reason: 'invalid_type' },
    });
    (memory.placeTypes.get(catalog.placeTypeId) as { isOther: boolean }).isOther = true;
    await expect(simulate.execute(request(catalog))).rejects.toMatchObject({
      code: 'CLEANING_OFFER_NOT_AVAILABLE',
    });
  });
});

describe('UC-NT-28 — simulateur de test (R-CA-08)', () => {
  it('brouillon d’une offre inactive : usesDrafts, rien n’est écrit', async () => {
    const { memory, catalog, deps } = await published();
    const tariffs = new TariffsUseCases(deps);
    const draft = await asStaff(() =>
      tariffs.createDraft({
        ...SOL_TARIFF,
        minimum: 40_000,
        offerId: catalog.solOfferId,
        idempotencyKey: 'cle-sol-0002',
      }),
    );
    (memory.offers.get(catalog.solOfferId) as { active: boolean }).active = false;
    const writes = memory.writes;
    const result = await asStaff(() =>
      new SimulateWithDraftsUseCase(deps).execute({ ...request(catalog), draftTariffIds: [draft.id] }),
    );
    expect(result.pricing).toMatchObject({ usesDrafts: true });
    expect(result.pricing.offers[0]).toMatchObject({
      tariffStatus: 'draft',
      tariffVersion: 2,
      price: 40_000,
      minimumApplied: true,
    });
    expect(memory.writes).toBe(writes);
    await expect(
      asStaff(() =>
        new SimulateWithDraftsUseCase(deps).execute({ ...request(catalog), draftTariffIds: ['x'] }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_TARIFF_NOT_FOUND' });
    await expect(
      new SimulateWithDraftsUseCase(deps).execute({ ...request(catalog), draftTariffIds: [] }),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });
});

describe('UC-NT-02 — aperçu des dates (R-PG-01 à 04)', () => {
  it('liste exacte des dates, jours fériés exclus et signalés', async () => {
    const { memory, deps } = await published();
    memory.holidays.set('h1', { id: 'h1', date: '2027-01-11', name: 'Fête du vodoun', active: true });
    const preview = await new PreviewScheduleUseCase(deps).execute({ schedule: WEEKLY_12 });
    expect(preview.count).toBe(11);
    expect(preview.occurrences[0]).toEqual({
      date: '2027-01-04',
      start: new Date('2027-01-04T07:00:00.000Z'),
    });
    expect(preview.notices).toEqual([
      { code: 'holiday_excluded', date: '2027-01-11', label: 'Fête du vodoun' },
    ]);
    await expect(new PreviewScheduleUseCase(deps).execute({})).rejects.toMatchObject({
      details: { field: 'schedule', reason: 'required' },
    });
    await expect(
      new PreviewScheduleUseCase(deps).execute({
        schedule: {
          ...WEEKLY_12,
          kind: 'one_off',
          weekdays: [],
          startDate: undefined,
          durationWeeks: undefined,
          dates: ['2027-01-11'],
        },
      }),
    ).rejects.toMatchObject({ code: 'CLEANING_SCHEDULE_EMPTY' });
  });
});
