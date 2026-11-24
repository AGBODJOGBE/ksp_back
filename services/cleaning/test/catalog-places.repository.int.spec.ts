import { type PlaceCategory, type PlaceType } from '../src/application/catalog/catalog.ports';
import { DuplicateKeyError } from '../src/application/ports';
import { PrismaPlaceCatalogRepository } from '../src/infrastructure/persistence/catalog/prisma-place-catalog.repository';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/** Catégories et lieux du catalogue sur un vrai PostgreSQL : écriture, relecture, unicité, audit. */
describeWithDatabase('PrismaPlaceCatalogRepository (PostgreSQL)', () => {
  let db: TestDatabase;
  let repository: PrismaPlaceCatalogRepository;
  const ids = new UuidV7Generator();
  const at = new Date('2026-11-20T10:00:00.000Z');
  const actor = '0192f1c4-0000-7000-8000-00000000ad01';

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_places');
    repository = new PrismaPlaceCatalogRepository(db.prisma, ids);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const category = (patch: Partial<PlaceCategory> = {}): PlaceCategory => ({
    id: ids.next(),
    code: 'maison',
    name: 'Maison',
    icon: null,
    order: 0,
    active: true,
    visitFee: 5000,
    updatedAt: at,
    updatedBy: actor,
    ...patch,
  });

  const parameter = async (code: string, kind: 'number' | 'boolean') => {
    const id = ids.next();
    await db.prisma.parameter.create({
      data: {
        id,
        code,
        label: code,
        kind,
        unit: kind === 'number' ? 'm²' : null,
        createdAt: at,
        updatedAt: at,
      },
    });
    return id;
  };

  it('catégorie : créée avec sa trace et sa clé, relue, modifiée ; code unique', async () => {
    const maison = category();
    await repository.saveCategory(maison, 'create', {
      events: [],
      audit: [
        {
          actorId: actor,
          action: 'catalog.category.created',
          entityType: 'place_category',
          entityId: maison.id,
          at,
        },
      ],
      idempotency: {
        actorId: actor,
        operation: 'catalog.category.create',
        key: 'cle-0001',
        requestHash: 'h',
        response: { id: maison.id },
        at,
      },
    });
    expect(await repository.getCategory(maison.id)).toEqual(maison);
    expect(await db.prisma.auditEntry.count({ where: { entityId: maison.id } })).toBe(1);
    expect(await db.prisma.idempotencyRecord.count()).toBe(1);

    await repository.saveCategory(
      { ...maison, name: 'Maisons', icon: 'house', active: false, visitFee: null },
      'update',
      {
        events: [],
        audit: [],
      },
    );
    expect(await repository.getCategory(maison.id)).toMatchObject({
      name: 'Maisons',
      icon: 'house',
      active: false,
      visitFee: null,
    });

    await expect(repository.saveCategory(category(), 'create', { events: [], audit: [] })).rejects.toEqual(
      new DuplicateKeyError('code'),
    );
    expect(await repository.getCategory('pas-un-uuid')).toBeNull();
    expect((await repository.listCategories()).map((item) => item.code)).toEqual(['maison']);
  });

  it('clé d’idempotence déjà consommée : rien n’est écrit', async () => {
    const bureaux = category({ code: 'bureaux' });
    const record = {
      actorId: actor,
      operation: 'catalog.category.create',
      key: 'cle-0001',
      requestHash: 'h',
      response: {},
      at,
    };
    await expect(
      repository.saveCategory(bureaux, 'create', { events: [], audit: [], idempotency: record }),
    ).rejects.toEqual(new DuplicateKeyError('idempotency'));
    expect(await repository.getCategory(bureaux.id)).toBeNull();
  });

  it('lieu : paramètres ordonnés remplacés en entier, superficie, lieu « Autre »', async () => {
    const home = category({ code: 'logement' });
    await repository.saveCategory(home, 'create', { events: [], audit: [] });
    const area = await parameter('surface', 'number');
    const yard = await parameter('jardin', 'boolean');
    const villa: PlaceType = {
      id: ids.next(),
      code: 'villa',
      categoryId: home.id,
      name: 'Villa',
      icon: null,
      photoFileId: null,
      description: 'Maison individuelle',
      order: 1,
      active: false,
      isOther: false,
      parameters: [
        { parameterId: area, code: 'surface' },
        { parameterId: yard, code: 'jardin' },
      ],
      areaParameterId: area,
      updatedAt: at,
      updatedBy: actor,
    };
    await repository.savePlaceType(villa, 'create', { events: [], audit: [] });
    expect(await repository.getPlaceType(villa.id)).toEqual(villa);

    const reordered = { ...villa, active: true, parameters: [villa.parameters[1]!, villa.parameters[0]!] };
    await repository.savePlaceType(reordered, 'update', { events: [], audit: [] });
    expect((await repository.getPlaceType(villa.id))?.parameters.map((link) => link.code)).toEqual([
      'jardin',
      'surface',
    ]);

    const other: PlaceType = {
      ...villa,
      id: ids.next(),
      code: 'autre',
      isOther: true,
      parameters: [],
      areaParameterId: null,
    };
    await repository.savePlaceType(other, 'create', { events: [], audit: [] });
    expect((await repository.listPlaceTypes()).map((placeType) => placeType.code).sort()).toEqual([
      'autre',
      'villa',
    ]);
    await expect(
      repository.savePlaceType({ ...other, id: ids.next() }, 'create', { events: [], audit: [] }),
    ).rejects.toEqual(new DuplicateKeyError('code'));
  });
});
