import { type Offer, type TariffVersion } from '../src/application/catalog/catalog.ports';
import { DuplicateKeyError } from '../src/application/ports';
import { PrismaOfferRepository } from '../src/infrastructure/persistence/catalog/prisma-offer.repository';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/** Offres et versions de tarif sur un vrai PostgreSQL : brouillon, publication, archivage. */
describeWithDatabase('PrismaOfferRepository (PostgreSQL)', () => {
  let db: TestDatabase;
  let offers: PrismaOfferRepository;
  const ids = new UuidV7Generator();
  const at = new Date('2026-11-20T10:00:00.000Z');
  const actor = '0192f1c4-0000-7000-8000-00000000ad01';
  const none = { events: [], audit: [] };
  const refs = { villa: '', sol: '', vitres: '', superficie: '', chambres: '', salete: '' };

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_offers');
    offers = new PrismaOfferRepository(db.prisma, ids);
    const parameter = async (code: string, kind: 'number' | 'choice') => {
      const id = ids.next();
      await db.prisma.parameter.create({
        data: {
          id,
          code,
          label: code,
          kind,
          unit: kind === 'number' ? 'm²' : null,
          choices: kind === 'choice' ? [{ code: 'apres_travaux', label: 'Après travaux', active: true }] : [],
          createdAt: at,
          updatedAt: at,
        },
      });
      return id;
    };
    refs.superficie = await parameter('superficie', 'number');
    refs.chambres = await parameter('chambres', 'number');
    refs.salete = await parameter('salete', 'choice');
    const category = ids.next();
    await db.prisma.placeCategory.create({
      data: { id: category, code: 'maison', name: 'Maison', icon: '', createdAt: at, updatedAt: at },
    });
    refs.villa = ids.next();
    await db.prisma.placeType.create({
      data: {
        id: refs.villa,
        categoryId: category,
        code: 'villa',
        name: 'Villa',
        icon: '',
        areaParameterId: refs.superficie,
        createdAt: at,
        updatedAt: at,
      },
    });
    await db.prisma.skill.create({
      data: { id: ids.next(), code: 'interieur', name: 'Intérieur', createdAt: at, updatedAt: at },
    });
    for (const code of ['sol', 'vitres'] as const) {
      refs[code] = ids.next();
      await db.prisma.cleaningType.create({
        data: {
          id: refs[code],
          code,
          name: code,
          icon: '',
          requiredSkillCode: 'interieur',
          referenceDurationMinutes: 60,
          createdAt: at,
          updatedAt: at,
        },
      });
    }
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const offer = (patch: Partial<Offer> = {}): Offer => ({
    id: ids.next(),
    placeTypeId: refs.villa,
    cleaningTypeId: refs.sol,
    extraParameters: [],
    teamRule: [
      { fromArea: 0, toArea: 100, agents: 2, durationMinutes: 180 },
      { fromArea: 101, toArea: null, agents: 3, durationMinutes: 240 },
    ],
    order: 0,
    active: false,
    createdAt: at,
    updatedAt: at,
    updatedBy: actor,
    ...patch,
  });

  const draft = (offerId: string, version: number): TariffVersion => ({
    id: ids.next(),
    offerId,
    version,
    status: 'draft',
    baseParameterId: refs.superficie,
    baseParameterCode: 'superficie',
    brackets: [
      { from: 0, to: 50, mode: 'flat', amount: 10_000 },
      { from: 51, to: 150, mode: 'per_unit', amount: 180 },
    ],
    supplements: [
      {
        parameterId: refs.chambres,
        parameterCode: 'chambres',
        choiceCode: null,
        mode: 'per_unit',
        amount: 1500,
        coefficientBps: null,
        includedUnits: 3,
      },
      {
        parameterId: refs.salete,
        parameterCode: 'salete',
        choiceCode: 'apres_travaux',
        mode: 'coefficient',
        amount: null,
        coefficientBps: 13_000,
        includedUnits: 0,
      },
    ],
    minimum: 10_000,
    frequencyCoefficients: [{ key: 'weekly', coefficientBps: 9000 }],
    packDiscountBps: null,
    createdAt: at,
    createdBy: actor,
    publishedAt: null,
    publishedBy: null,
  });

  it('offre : règle d’équipe aux noms du contrat, paramètres propres ordonnés, une par lieu et type', async () => {
    const sol = offer({ extraParameters: [{ parameterId: refs.chambres, code: 'chambres' }] });
    await offers.saveOffer(sol, 'create', none);
    expect(await offers.getOffer(sol.id)).toEqual(sol);
    const raw = await db.pool.query('SELECT team_rule FROM offers WHERE id = $1', [sol.id]);
    expect(raw.rows[0].team_rule[0]).toEqual({ fromArea: 0, toArea: 100, agents: 2, durationMinutes: 180 });
    await offers.saveOffer({ ...sol, active: true, order: 2, extraParameters: [] }, 'update', none);
    expect(await offers.getOffer(sol.id)).toMatchObject({ active: true, order: 2, extraParameters: [] });
    await expect(offers.saveOffer(offer(), 'create', none)).rejects.toEqual(new DuplicateKeyError('code'));
    expect(await offers.listOffers({ placeTypeId: refs.villa })).toHaveLength(1);
    expect(await offers.listOffers({ cleaningTypeId: refs.vitres })).toEqual([]);
    expect(await offers.listOffers({ placeTypeId: 'x' })).toEqual([]);
  });

  it('tarif : brouillon relu, remplacé, publié ; la version précédente est archivée', async () => {
    const [sol] = await offers.listOffers({ cleaningTypeId: refs.sol });
    const v1 = draft(sol!.id, 1);
    await offers.saveDraft(v1, 'create', none);
    expect((await offers.getTariffsByIds([v1.id]))[0]).toEqual(v1);
    const replaced = {
      ...v1,
      minimum: 12_000,
      brackets: [{ from: 0, to: 400, mode: 'flat' as const, amount: 20_000 }],
    };
    await offers.saveDraft(replaced, 'update', none);
    expect((await offers.getTariffsByIds([v1.id]))[0]).toEqual(replaced);
    await expect(offers.saveDraft(draft(sol!.id, 1), 'create', none)).rejects.toEqual(
      new DuplicateKeyError('concurrent'),
    );

    await offers.publish({ tariffId: v1.id, previousPublishedId: null, at, by: actor, changes: none });
    await expect(offers.saveDraft(replaced, 'update', none)).rejects.toEqual(
      new DuplicateKeyError('concurrent'),
    );
    const v2 = draft(sol!.id, 2);
    await offers.saveDraft(v2, 'create', none);
    await offers.publish({
      tariffId: v2.id,
      previousPublishedId: v1.id,
      at,
      by: actor,
      changes: {
        events: [],
        audit: [
          { actorId: actor, action: 'catalog.tariff.published', entityType: 'tariff', entityId: v2.id, at },
        ],
      },
    });
    const versions = await offers.listTariffs([sol!.id]);
    expect(versions.map((tariff) => [tariff.version, tariff.status, tariff.publishedBy])).toEqual([
      [2, 'published', actor],
      [1, 'archived', actor],
    ]);
    expect(await db.prisma.auditEntry.count({ where: { entityId: v2.id } })).toBe(1);
  });

  it('publication concurrente : la deuxième échoue sans rien changer', async () => {
    const [sol] = await offers.listOffers({ cleaningTypeId: refs.sol });
    const v3 = draft(sol!.id, 3);
    await offers.saveDraft(v3, 'create', none);
    const current = (await offers.listTariffs([sol!.id])).find((tariff) => tariff.status === 'published')!;
    await expect(
      offers.publish({ tariffId: v3.id, previousPublishedId: ids.next(), at, by: actor, changes: none }),
    ).rejects.toEqual(new DuplicateKeyError('concurrent'));
    expect((await offers.getTariffsByIds([v3.id, current.id])).map((tariff) => tariff.status).sort()).toEqual(
      ['draft', 'published'],
    );
    expect(await offers.listTariffs(['x'])).toEqual([]);
    expect(await offers.getTariffsByIds(['x'])).toEqual([]);
  });
});
