import { asStaff, CatalogMemory, NOW } from '../testing/catalog-fakes';
import { ParametersUseCases } from './parameters.use-cases';

function setup() {
  const memory = new CatalogMemory();
  return { memory, parameters: new ParametersUseCases(memory.deps()) };
}

const salete = {
  idempotencyKey: 'cle-param-0001',
  code: 'salete',
  label: 'Niveau de saleté',
  kind: 'choice',
  choices: [
    { code: 'normal', label: 'Normal', active: true },
    { code: 'apres_travaux', label: 'Après travaux', active: true },
  ],
  required: true,
};

describe('UC-NT-27 — paramètres (R-CA-01, R-CA-06, R-CA-11)', () => {
  it('crée un paramètre nombre avec son unité, tracé', async () => {
    const { memory, parameters } = setup();
    const created = await asStaff(() =>
      parameters.create({
        idempotencyKey: 'cle-param-0002',
        code: 'superficie',
        label: 'Superficie',
        kind: 'number',
        unit: 'm²',
        min: 0,
        max: 5000,
      }),
    );
    expect(created).toMatchObject({
      kind: 'number',
      unit: 'm²',
      min: 0,
      max: 5000,
      required: false,
      active: true,
    });
    expect(memory.audit[0]).toMatchObject({ action: 'catalog.parameter.created', entityType: 'parameter' });
  });

  it('refuse une nature inconnue, un nombre sans unité, un code déjà pris', async () => {
    const { parameters } = setup();
    await expect(
      asStaff(() =>
        parameters.create({ idempotencyKey: 'cle-param-0003', code: 'x1', label: 'X', kind: 'texte' }),
      ),
    ).rejects.toMatchObject({ details: { field: 'kind', reason: 'invalid_type' } });
    await expect(
      asStaff(() =>
        parameters.create({ idempotencyKey: 'cle-param-0004', code: 'x1', label: 'X', kind: 'number' }),
      ),
    ).rejects.toMatchObject({ details: { field: 'unit', reason: 'required' } });
    await asStaff(() => parameters.create(salete));
    await expect(
      asStaff(() => parameters.create({ ...salete, idempotencyKey: 'cle-param-0005' })),
    ).rejects.toMatchObject({
      code: 'CLEANING_CODE_ALREADY_USED',
    });
  });

  it('libre tant qu’il n’est pas utilisé : retirer une valeur, désactiver', async () => {
    const { parameters } = setup();
    const created = await asStaff(() => parameters.create(salete));
    const updated = await asStaff(() =>
      parameters.update({
        id: created.id,
        choices: [{ code: 'normal', label: 'Normal', active: true }],
        active: false,
      }),
    );
    expect(updated).toMatchObject({ active: false, choices: [{ code: 'normal' }] });
  });

  it('utilisé par un tarif publié ou un lieu actif : ni resserré, ni privé d’une valeur, ni désactivé', async () => {
    const { memory, parameters } = setup();
    const created = await asStaff(() => parameters.create(salete));
    memory.placeTypes.set('pt1', {
      id: 'pt1',
      code: 'villa',
      categoryId: 'c1',
      name: 'Villa',
      icon: null,
      photoFileId: null,
      description: null,
      order: 0,
      active: true,
      isOther: false,
      parameters: [{ parameterId: created.id, code: 'salete' }],
      areaParameterId: null,
      updatedAt: NOW,
      updatedBy: null,
    });
    await expect(asStaff(() => parameters.update({ id: created.id, active: false }))).rejects.toMatchObject({
      code: 'CLEANING_PARAMETER_IN_USE',
      details: { offerIds: [], placeTypeIds: ['pt1'] },
    });
    await expect(
      asStaff(() =>
        parameters.update({ id: created.id, choices: [{ code: 'normal', label: 'Normal', active: true }] }),
      ),
    ).rejects.toMatchObject({ code: 'CLEANING_PARAMETER_IN_USE' });
    const deactivatedChoice = await asStaff(() =>
      parameters.update({
        id: created.id,
        label: 'Saleté',
        choices: [
          { code: 'normal', label: 'Normal', active: true },
          { code: 'apres_travaux', label: 'Après travaux', active: false },
        ],
      }),
    );
    expect(deactivatedChoice.choices[1]).toEqual({
      code: 'apres_travaux',
      label: 'Après travaux',
      active: false,
    });
    expect(memory.audit.at(-1)).toMatchObject({
      action: 'catalog.parameter.updated',
      details: { fields: ['label', 'choiceCodes'], before: { choiceCodes: ['normal', 'apres_travaux'] } },
    });
  });

  it('nombre utilisé : bornes élargies acceptées, resserrées refusées', async () => {
    const { memory, parameters } = setup();
    const area = await asStaff(() =>
      parameters.create({
        idempotencyKey: 'cle-param-0006',
        code: 'superficie',
        label: 'Superficie',
        kind: 'number',
        unit: 'm²',
        min: 1,
        max: 5000,
      }),
    );
    memory.tariffs.set('t1', {
      id: 't1',
      offerId: 'o1',
      version: 1,
      status: 'published',
      baseParameterId: area.id,
      baseParameterCode: 'superficie',
      brackets: [],
      supplements: [],
      minimum: 0,
      frequencyCoefficients: [],
      packDiscountBps: null,
      createdAt: NOW,
      createdBy: 'a',
      publishedAt: NOW,
      publishedBy: 'a',
    });
    await expect(
      asStaff(() => parameters.update({ id: area.id, min: 0, max: 10_000 })),
    ).resolves.toMatchObject({ min: 0 });
    await expect(asStaff(() => parameters.update({ id: area.id, max: 400 }))).rejects.toMatchObject({
      code: 'CLEANING_PARAMETER_IN_USE',
      details: { offerIds: ['o1'] },
    });
  });

  it('liste par code, détail, introuvable', async () => {
    const { parameters } = setup();
    await asStaff(() => parameters.create(salete));
    await asStaff(() =>
      parameters.create({ idempotencyKey: 'cle-param-0007', code: 'cour', label: 'Cour', kind: 'boolean' }),
    );
    const page = await asStaff(() => parameters.list({}));
    expect(page.items.map((item) => item.code)).toEqual(['cour', 'salete']);
    await expect(asStaff(() => parameters.get('inconnu'))).rejects.toMatchObject({
      code: 'CLEANING_PARAMETER_NOT_FOUND',
    });
    await expect(asStaff(() => parameters.update({ id: 'inconnu' }))).rejects.toMatchObject({
      code: 'CLEANING_PARAMETER_NOT_FOUND',
    });
  });
});
