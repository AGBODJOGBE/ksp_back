import { catalogUseCases, type CatalogUseCases } from '../src/application/catalog/catalog-use-cases';
import { type CleaningDeps } from '../src/application/deps';
import { asStaff } from '../src/application/testing/catalog-fakes';
import { SOL_TARIFF, VITRES_TARIFF } from '../src/application/testing/catalog-fixtures';
import {
  PrismaCatalogSettingsReader,
  PrismaIdempotencyStore,
} from '../src/infrastructure/persistence/catalog/prisma-catalog-settings';
import { PrismaCleaningTypeRepository } from '../src/infrastructure/persistence/catalog/prisma-cleaning-type.repository';
import { PrismaHolidayRepository } from '../src/infrastructure/persistence/catalog/prisma-holiday.repository';
import { PrismaOfferRepository } from '../src/infrastructure/persistence/catalog/prisma-offer.repository';
import { PrismaParameterRepository } from '../src/infrastructure/persistence/catalog/prisma-parameter.repository';
import { PrismaPlaceCatalogRepository } from '../src/infrastructure/persistence/catalog/prisma-place-catalog.repository';
import { PrismaZoneRepository } from '../src/infrastructure/persistence/catalog/prisma-zone.repository';
import { SystemClock, UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/**
 * Critère du lot A (partie 18), de bout en bout côté service, sur un vrai PostgreSQL : l'admin crée
 * « Maison × Sol » avec 3 tranches et des suppléments (et « Maison × Vitres » de l'exemple), publie,
 * puis le simulateur public donne l'exemple de la partie 5 au franc près, en moins de 300 ms.
 * Seuls identity (noms) et geo (communes) sont remplacés par des faux.
 */
describeWithDatabase('critère du lot A (PostgreSQL)', () => {
  let db: TestDatabase;
  let useCases: CatalogUseCases;
  const ids = new UuidV7Generator();
  const created: Record<string, string> = {};

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_lot_a');
    const deps: CleaningDeps = {
      people: { userNames: async () => new Map(), organizationNames: async () => new Map() },
      wallet: {} as CleaningDeps['wallet'],
      photos: {} as CleaningDeps['photos'],
      planning: {} as CleaningDeps['planning'],
      travel: {} as CleaningDeps['travel'],
      cipher: {} as CleaningDeps['cipher'],
      geocoder: { reverse: async () => null },
      clock: new SystemClock(),
      ids,
      places: new PrismaPlaceCatalogRepository(db.prisma, ids),
      parameters: new PrismaParameterRepository(db.prisma, ids),
      cleaningTypes: new PrismaCleaningTypeRepository(db.prisma, ids),
      offers: new PrismaOfferRepository(db.prisma, ids),
      zones: new PrismaZoneRepository(db.prisma, ids),
      holidays: new PrismaHolidayRepository(db.prisma, ids),
      settings: new PrismaCatalogSettingsReader(db.prisma),
      communes: { listCommunes: async () => [{ key: 'cotonou', name: 'Cotonou' }] },
      idempotency: new PrismaIdempotencyStore(db.prisma),
      // Lot C : hors du critère du lot A.
      cases: {} as CleaningDeps['cases'],
      clientPlaces: {} as CleaningDeps['clientPlaces'],
      caseSettings: {} as CleaningDeps['caseSettings'],
      communeResolver: {} as CleaningDeps['communeResolver'],
      balances: {} as CleaningDeps['balances'],
      directPayments: {} as CleaningDeps['directPayments'],
    };
    useCases = catalogUseCases(deps);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  it('l’admin crée et publie « Maison × Sol » (3 tranches, suppléments) et « Maison × Vitres »', async () => {
    await asStaff(async () => {
      await useCases.zones.create({ idempotencyKey: 'cle-zone-cotonou', communeKey: 'cotonou' });
      await useCases.skills.create({
        idempotencyKey: 'cle-skill-interieur',
        code: 'interieur',
        name: 'Nettoyage intérieur',
      });
      const parameter = (key: string, input: Parameters<CatalogUseCases['parameters']['create']>[0]) =>
        useCases.parameters
          .create({ ...input, idempotencyKey: `cle-param-${key}` })
          .then((p) => (created[p.code] = p.id));
      await parameter('superficie', {
        idempotencyKey: '',
        code: 'superficie',
        label: 'superficie',
        kind: 'number',
        unit: 'm²',
        min: 0,
        max: 5000,
        required: true,
      });
      await parameter('chambres', {
        idempotencyKey: '',
        code: 'chambres',
        label: 'chambres',
        kind: 'number',
        unit: 'chambres',
        min: 0,
        max: 50,
      });
      await parameter('cour', { idempotencyKey: '', code: 'cour', label: 'cour', kind: 'boolean' });
      await parameter('arriere', {
        idempotencyKey: '',
        code: 'arriere_cour',
        label: 'arrière-cour',
        kind: 'boolean',
      });
      await parameter('salete', {
        idempotencyKey: '',
        code: 'salete',
        label: 'niveau de saleté',
        kind: 'choice',
        choices: [
          { code: 'normal', label: 'normal', active: true },
          { code: 'apres_travaux', label: 'après travaux', active: true },
        ],
      });
      await parameter('fenetres', {
        idempotencyKey: '',
        code: 'fenetres',
        label: 'fenêtres',
        kind: 'number',
        unit: 'fenêtres',
        min: 1,
        max: 200,
        required: true,
      });

      const maison = await useCases.categories.create({
        idempotencyKey: 'cle-cat-maison',
        code: 'maison',
        name: 'Maison',
      });
      const villa = await useCases.placeTypes.create({
        idempotencyKey: 'cle-lieu-villa',
        code: 'villa',
        categoryId: maison.id,
        name: 'Villa',
        parameterIds: ['superficie', 'chambres', 'cour', 'arriere_cour', 'salete'].map(
          (code) => created[code]!,
        ),
        areaParameterId: created.superficie,
        active: true,
      });
      created.villa = villa.id;
      for (const [code, name, minutes] of [
        ['sol', 'Sol', 180],
        ['vitres', 'Vitres', 60],
      ] as const) {
        const type = await useCases.cleaningTypes.create({
          idempotencyKey: `cle-type-${code}`,
          code,
          name,
          requiredSkillCode: 'interieur',
          referenceDurationMinutes: minutes,
        });
        created[code] = type.id;
      }
      const sol = await useCases.offers.create({
        idempotencyKey: 'cle-offre-sol',
        placeTypeId: villa.id,
        cleaningTypeId: created.sol!,
        teamRule: [
          { fromArea: 0, toArea: 100, agents: 2, durationMinutes: 180 },
          { fromArea: 101, toArea: null, agents: 3, durationMinutes: 240 },
        ],
        active: true,
      });
      const vitres = await useCases.offers.create({
        idempotencyKey: 'cle-offre-vitres',
        placeTypeId: villa.id,
        cleaningTypeId: created.vitres!,
        extraParameterIds: [created.fenetres!],
        active: true,
      });
      for (const [offer, tariff, key] of [
        [sol, SOL_TARIFF, 'sol'],
        [vitres, VITRES_TARIFF, 'vitres'],
      ] as const) {
        const draft = await useCases.tariffs.createDraft({
          ...tariff,
          offerId: offer.id,
          idempotencyKey: `cle-tarif-${key}`,
        });
        await useCases.tariffs.publish({
          offerId: offer.id,
          version: draft.version,
          idempotencyKey: `cle-publie-${key}`,
        });
      }
      expect(await useCases.offers.get(sol.id)).toMatchObject({ currentTariffVersion: 1, hiddenReasons: [] });
      expect((await useCases.tariffs.list({ offerId: sol.id })).items[0]).toMatchObject({
        status: 'published',
        brackets: SOL_TARIFF.brackets,
      });
    });
    const actions = (await db.prisma.auditEntry.findMany({ select: { action: true } })).map(
      (entry) => entry.action,
    );
    expect(actions.filter((action) => action === 'catalog.tariff.published')).toHaveLength(2);
    // Une clé par création et par publication : zone, compétence, 6 paramètres, catégorie, lieu,
    // 2 types, 2 offres, 2 brouillons, 2 publications ; une trace pour chacune.
    expect(await db.prisma.idempotencyRecord.count()).toBe(18);
    expect(actions).toHaveLength(18);
    expect(await db.prisma.outboxEvent.count()).toBe(0);
  });

  const simulate = () =>
    useCases.simulate.execute({
      placeTypeId: created.villa!,
      cleaningTypeIds: [created.sol!, created.vitres!],
      values: { superficie: 120, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 },
      schedule: {
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
      },
      communeKey: 'cotonou',
    });

  it('le simulateur public donne l’exemple de la partie 5 au franc près', async () => {
    const result = await simulate();
    expect(result.pricing.offers.map((offer) => [offer.name, offer.price])).toEqual([
      ['Sol', 26_640],
      ['Vitres', 5400],
    ]);
    expect(result.pricing.offers[0]?.lines.map((line) => line.amount)).toEqual([21_600, 5000, 3000, -2960]);
    expect(result.pricing).toMatchObject({
      status: 'priced',
      covered: true,
      sessionPrice: 32_040,
      sessionsCount: 12,
      programTotal: 384_480,
      range: { low: 28_500, high: 37_000 },
      frequencyDiscount: 3560,
      teamSize: 3,
      durationMinutes: 300,
    });
  });

  it('temps de réponse du simulateur sous 300 ms', async () => {
    await simulate();
    const durations: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      await simulate();
      durations.push(performance.now() - start);
    }
    expect(Math.max(...durations)).toBeLessThan(300);
  });
});
