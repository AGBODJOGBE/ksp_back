import { asStaff, CatalogMemory, NOW, STAFF_ID } from '../testing/catalog-fakes';
import { PlaceCategoriesUseCases, PlaceTypesUseCases } from './places.use-cases';

function setup() {
  const memory = new CatalogMemory();
  const deps = memory.deps();
  return { memory, categories: new PlaceCategoriesUseCases(deps), placeTypes: new PlaceTypesUseCases(deps) };
}

const parameter = (memory: CatalogMemory, code: string, kind: 'number' | 'boolean' = 'number') => {
  const id = memory.nextId();
  memory.parameters.set(id, {
    id,
    code,
    label: code,
    kind,
    unit: kind === 'number' ? 'm²' : null,
    min: kind === 'number' ? 0 : null,
    max: null,
    choices: [],
    required: true,
    help: null,
    active: true,
    updatedAt: NOW,
    updatedBy: null,
  });
  return id;
};

describe('UC-NT-25 — catégories de lieu', () => {
  it('crée une catégorie active, tracée, idempotente par clé', async () => {
    const { memory, categories } = setup();
    const input = { idempotencyKey: 'cle-categorie-1', code: 'maison', name: '  Maison ', visitFee: 5000 };
    const created = await asStaff(() => categories.create(input));
    expect(created).toMatchObject({
      code: 'maison',
      name: 'Maison',
      active: true,
      visitFee: 5000,
      order: 0,
      updatedBy: STAFF_ID,
    });
    expect(memory.audit).toEqual([
      expect.objectContaining({
        action: 'catalog.category.created',
        entityType: 'place_category',
        entityId: created.id,
        details: expect.objectContaining({
          after: { code: 'maison', order: 0, active: true, visitFee: 5000 },
        }),
      }),
    ]);
    await expect(asStaff(() => categories.create(input))).resolves.toEqual(created);
    expect(memory.writes).toBe(1);
    await expect(asStaff(() => categories.create({ ...input, name: 'Autre nom' }))).rejects.toMatchObject({
      code: 'CLEANING_IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('code déjà pris, nom vide, frais négatifs refusés', async () => {
    const { categories } = setup();
    await asStaff(() =>
      categories.create({ idempotencyKey: 'cle-categorie-1', code: 'maison', name: 'Maison' }),
    );
    await expect(
      asStaff(() =>
        categories.create({ idempotencyKey: 'cle-categorie-2', code: 'maison', name: 'Maison 2' }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_CODE_ALREADY_USED', details: { code: 'maison' } });
    await expect(
      asStaff(() => categories.create({ idempotencyKey: 'cle-categorie-3', code: 'bureaux', name: ' ' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_VALIDATION_FAILED',
      details: { field: 'name', reason: 'required' },
    });
    await expect(
      asStaff(() =>
        categories.create({ idempotencyKey: 'cle-categorie-4', code: 'bureaux', name: 'B', visitFee: -1 }),
      ),
    ).rejects.toMatchObject({ details: { field: 'visitFee', reason: 'out_of_range' } });
  });

  it('modifie ou désactive sans supprimer ; champs absents inchangés ; liste triée et paginée', async () => {
    const { memory, categories } = setup();
    const maison = await asStaff(() =>
      categories.create({ idempotencyKey: 'cle-categorie-1', code: 'maison', name: 'Maison', order: 2 }),
    );
    await asStaff(() =>
      categories.create({ idempotencyKey: 'cle-categorie-2', code: 'bureaux', name: 'Bureaux', order: 1 }),
    );
    const updated = await asStaff(() => categories.update({ id: maison.id, active: false, visitFee: 3000 }));
    expect(updated).toMatchObject({ name: 'Maison', active: false, visitFee: 3000 });
    expect(memory.audit.at(-1)).toMatchObject({
      action: 'catalog.category.updated',
      details: {
        fields: ['active', 'visitFee'],
        before: { active: true, visitFee: null },
        after: { active: false, visitFee: 3000 },
      },
    });
    const page = await asStaff(() => categories.list({ limit: 1 }));
    expect(page).toMatchObject({ total: 2, items: [{ code: 'bureaux' }] });
    expect((await asStaff(() => categories.list({ sort: 'name' }))).items.map((item) => item.code)).toEqual([
      'bureaux',
      'maison',
    ]);
    await expect(asStaff(() => categories.update({ id: 'inconnu' }))).rejects.toMatchObject({
      code: 'CLEANING_PLACE_CATEGORY_NOT_FOUND',
    });
    await expect(asStaff(() => categories.get('inconnu'))).rejects.toMatchObject({
      code: 'CLEANING_PLACE_CATEGORY_NOT_FOUND',
    });
  });

  it('réservé au personnel connecté', async () => {
    const { categories } = setup();
    await expect(categories.list({})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});

describe('UC-NT-25 — lieux (R-CA-01, R-CA-05, R-CA-12, R-CA-14)', () => {
  async function withCategory() {
    const context = setup();
    const category = await asStaff(() =>
      context.categories.create({ idempotencyKey: 'cle-categorie-1', code: 'maison', name: 'Maison' }),
    );
    const superficie = parameter(context.memory, 'superficie');
    const cour = parameter(context.memory, 'cour', 'boolean');
    return { ...context, category, superficie, cour };
  }

  it('crée un lieu inactif, masqué, avec ses paramètres ordonnés et sa superficie', async () => {
    const { placeTypes, category, superficie, cour, memory } = await withCategory();
    const villa = await asStaff(() =>
      placeTypes.create({
        idempotencyKey: 'cle-lieu-0001',
        code: 'villa',
        categoryId: category.id,
        name: 'Villa',
        parameterIds: [superficie, cour],
        areaParameterId: superficie,
      }),
    );
    expect(villa).toMatchObject({
      active: false,
      isOther: false,
      parameters: [
        { parameterId: superficie, code: 'superficie' },
        { parameterId: cour, code: 'cour' },
      ],
      hiddenReasons: ['inactive', 'no_active_offer'],
    });
    expect(memory.audit.at(-1)).toMatchObject({
      action: 'catalog.place_type.created',
      entityType: 'place_type',
    });
  });

  it('refuse une catégorie ou un paramètre inconnus, une superficie invalide', async () => {
    const { placeTypes, category, superficie, cour } = await withCategory();
    const base = {
      idempotencyKey: 'cle-lieu-0001',
      code: 'villa',
      name: 'Villa',
      parameterIds: [superficie],
      areaParameterId: superficie,
    };
    await expect(asStaff(() => placeTypes.create({ ...base, categoryId: 'inconnue' }))).rejects.toMatchObject(
      {
        code: 'CLEANING_PLACE_CATEGORY_NOT_FOUND',
      },
    );
    await expect(
      asStaff(() => placeTypes.create({ ...base, categoryId: category.id, parameterIds: ['p-inconnu'] })),
    ).rejects.toMatchObject({ code: 'CLEANING_PARAMETER_NOT_FOUND', details: { parameterId: 'p-inconnu' } });
    await expect(
      asStaff(() =>
        placeTypes.create({
          ...base,
          categoryId: category.id,
          parameterIds: [superficie, cour],
          areaParameterId: cour,
        }),
      ),
    ).rejects.toMatchObject({ details: { field: 'areaParameterId', reason: 'area_parameter_invalid' } });
    await expect(
      asStaff(() => placeTypes.create({ ...base, categoryId: category.id, areaParameterId: undefined })),
    ).rejects.toMatchObject({ details: { field: 'areaParameterId', reason: 'required' } });
  });

  it('lieu « Autre » : sans superficie, visible sans offre une fois actif', async () => {
    const { placeTypes, category } = await withCategory();
    const other = await asStaff(() =>
      placeTypes.create({
        idempotencyKey: 'cle-lieu-autre',
        code: 'autre',
        categoryId: category.id,
        name: 'Autre',
        freeDescription: true,
        active: true,
      }),
    );
    expect(other).toMatchObject({ isOther: true, areaParameterId: null, hiddenReasons: [] });
  });

  it('modification : liste remplacée seulement si présente, catégorie vérifiée, filtre par catégorie', async () => {
    const { placeTypes, category, superficie, cour, categories } = await withCategory();
    const villa = await asStaff(() =>
      placeTypes.create({
        idempotencyKey: 'cle-lieu-0001',
        code: 'villa',
        categoryId: category.id,
        name: 'Villa',
        parameterIds: [superficie],
        areaParameterId: superficie,
      }),
    );
    const renamed = await asStaff(() => placeTypes.update({ id: villa.id, name: 'Grande villa' }));
    expect(renamed.parameters).toHaveLength(1);
    const extended = await asStaff(() =>
      placeTypes.update({ id: villa.id, parameterIds: [superficie, cour] }),
    );
    expect(extended.parameters.map((link) => link.code)).toEqual(['superficie', 'cour']);
    await expect(
      asStaff(() => placeTypes.update({ id: villa.id, categoryId: 'inconnue' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_PLACE_CATEGORY_NOT_FOUND',
    });
    await expect(asStaff(() => placeTypes.update({ id: 'inconnu' }))).rejects.toMatchObject({
      code: 'CLEANING_PLACE_TYPE_NOT_FOUND',
    });
    const other = await asStaff(() =>
      categories.create({ idempotencyKey: 'cle-categorie-2', code: 'bureaux', name: 'Bureaux' }),
    );
    expect((await asStaff(() => placeTypes.list({ categoryId: other.id }))).total).toBe(0);
    expect((await asStaff(() => placeTypes.list({ categoryId: category.id, sort: 'name' }))).total).toBe(1);
    await expect(
      asStaff(() =>
        placeTypes.create({
          idempotencyKey: 'cle-lieu-0002',
          code: 'villa',
          categoryId: category.id,
          name: 'V',
          parameterIds: [superficie],
          areaParameterId: superficie,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_CODE_ALREADY_USED' });
  });
});
