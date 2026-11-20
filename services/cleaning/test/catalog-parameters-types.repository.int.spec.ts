import { type CleaningType, type Parameter } from '../src/application/catalog/catalog.ports';
import { DuplicateKeyError } from '../src/application/ports';
import { PrismaCleaningTypeRepository } from '../src/infrastructure/persistence/catalog/prisma-cleaning-type.repository';
import { PrismaParameterRepository } from '../src/infrastructure/persistence/catalog/prisma-parameter.repository';
import { UuidV7Generator } from '../src/infrastructure/system/system';
import {
  describeWithDatabase,
  HOOK_TIMEOUT_MS,
  openTestDatabase,
  type TestDatabase,
} from './support/database';

/** Paramètres, types de nettoyage, packs et compétences sur un vrai PostgreSQL. */
describeWithDatabase('PrismaParameterRepository et PrismaCleaningTypeRepository (PostgreSQL)', () => {
  let db: TestDatabase;
  let parameters: PrismaParameterRepository;
  let types: PrismaCleaningTypeRepository;
  const ids = new UuidV7Generator();
  const at = new Date('2026-11-20T10:00:00.000Z');
  const actor = '0192f1c4-0000-7000-8000-00000000ad01';
  const none = { events: [], audit: [] };

  beforeAll(async () => {
    db = await openTestDatabase('cleaning_params');
    parameters = new PrismaParameterRepository(db.prisma, ids);
    types = new PrismaCleaningTypeRepository(db.prisma, ids);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => db?.close(), HOOK_TIMEOUT_MS);

  const parameter = (patch: Partial<Parameter> = {}): Parameter => ({
    id: ids.next(),
    code: 'salete',
    label: 'Niveau de saleté',
    kind: 'choice',
    unit: null,
    min: null,
    max: null,
    choices: [
      { code: 'normal', label: 'Normal', active: true },
      { code: 'apres_travaux', label: 'Après travaux', active: false },
    ],
    required: true,
    help: null,
    active: true,
    updatedAt: at,
    updatedBy: actor,
    ...patch,
  });

  it('paramètre : valeurs de choix gardées dans l’ordre, modifié, code unique', async () => {
    const salete = parameter();
    await parameters.saveParameter(salete, 'create', none);
    expect(await parameters.getParameter(salete.id)).toEqual(salete);
    const updated = { ...salete, label: 'Saleté', help: 'Choisir', required: false };
    await parameters.saveParameter(updated, 'update', none);
    expect(await parameters.getParameter(salete.id)).toEqual(updated);
    await expect(parameters.saveParameter(parameter(), 'create', none)).rejects.toEqual(
      new DuplicateKeyError('code'),
    );
    expect(await parameters.getParameter('x')).toBeNull();
  });

  it('paramètre utilisé : tarif publié (base ou supplément) et lieu actif seulement', async () => {
    const area = parameter({
      code: 'superficie',
      kind: 'number',
      unit: 'm²',
      min: 0,
      max: 5000,
      choices: [],
    });
    await parameters.saveParameter(area, 'create', none);
    const category = ids.next();
    await db.prisma.placeCategory.create({
      data: { id: category, code: 'maison', name: 'Maison', icon: '', createdAt: at, updatedAt: at },
    });
    const villa = ids.next();
    await db.prisma.placeType.create({
      data: {
        id: villa,
        categoryId: category,
        code: 'villa',
        name: 'Villa',
        icon: '',
        areaParameterId: area.id,
        active: true,
        createdAt: at,
        updatedAt: at,
      },
    });
    const sleeping = ids.next();
    await db.prisma.placeType.create({
      data: {
        id: sleeping,
        categoryId: category,
        code: 'studio',
        name: 'Studio',
        icon: '',
        areaParameterId: area.id,
        active: false,
        createdAt: at,
        updatedAt: at,
      },
    });
    await db.prisma.skill.create({
      data: { id: ids.next(), code: 'interieur', name: 'Intérieur', createdAt: at, updatedAt: at },
    });
    const sol = ids.next();
    await db.prisma.cleaningType.create({
      data: {
        id: sol,
        code: 'sol',
        name: 'Sol',
        icon: '',
        requiredSkillCode: 'interieur',
        referenceDurationMinutes: 60,
        createdAt: at,
        updatedAt: at,
      },
    });
    const offer = ids.next();
    await db.prisma.offer.create({
      data: {
        id: offer,
        placeTypeId: villa,
        cleaningTypeId: sol,
        teamRule: [],
        createdAt: at,
        updatedAt: at,
      },
    });
    const tariff = {
      offerId: offer,
      baseParameterId: area.id,
      minimumPrice: 0,
      createdAt: at,
      createdBy: actor,
    };
    await db.prisma.tariffVersion.create({
      data: { ...tariff, id: ids.next(), version: 1, status: 'draft' },
    });
    expect(await parameters.usageOf(area.id)).toEqual({ offerIds: [], placeTypeIds: [villa] });
    await db.prisma.tariffVersion.create({
      data: {
        ...tariff,
        id: ids.next(),
        version: 2,
        status: 'published',
        publishedAt: at,
        publishedBy: actor,
      },
    });
    expect(await parameters.usageOf(area.id)).toEqual({ offerIds: [offer], placeTypeIds: [villa] });
  });

  it('type et pack : liste de contrôle, types contenus remplacés, compétence', async () => {
    const [skill] = await types.listSkills();
    expect(skill).toMatchObject({ code: 'interieur', active: true });
    await types.saveSkill({ ...skill!, name: 'Nettoyage intérieur', active: false }, 'update', at, none);
    expect(await types.getSkill(skill!.id)).toMatchObject({ name: 'Nettoyage intérieur', active: false });
    await expect(types.saveSkill({ ...skill!, id: ids.next() }, 'create', at, none)).rejects.toEqual(
      new DuplicateKeyError('code'),
    );

    const base: CleaningType = {
      id: ids.next(),
      code: 'vitres',
      name: 'Vitres',
      description: null,
      icon: 'window',
      requiredSkillCode: 'interieur',
      referenceDurationMinutes: 60,
      checklist: [{ code: 'vitres_lavees', label: 'Vitres lavées', order: 0 }],
      isPack: false,
      packItemIds: [],
      active: true,
      updatedAt: at,
      updatedBy: actor,
    };
    await types.saveCleaningType(base, 'create', none);
    expect(await types.getCleaningType(base.id)).toEqual(base);
    const sol = (await types.listCleaningTypes()).find((type) => type.code === 'sol')!;
    const pack: CleaningType = {
      ...base,
      id: ids.next(),
      code: 'complet',
      name: 'Complet',
      requiredSkillCode: null,
      isPack: true,
      checklist: [],
      packItemIds: [sol.id, base.id],
    };
    await types.saveCleaningType(pack, 'create', none);
    expect((await types.getCleaningType(pack.id))?.packItemIds).toEqual([sol.id, base.id]);
    await types.saveCleaningType({ ...pack, packItemIds: [base.id] }, 'update', none);
    expect((await types.getCleaningType(pack.id))?.packItemIds).toEqual([base.id]);
    await expect(types.saveCleaningType({ ...base, id: ids.next() }, 'create', none)).rejects.toEqual(
      new DuplicateKeyError('code'),
    );
  });
});
