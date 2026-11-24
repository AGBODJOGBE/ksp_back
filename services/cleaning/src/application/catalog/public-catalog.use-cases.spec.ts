import { CatalogMemory, NOW } from '../testing/catalog-fakes';
import { seedMaison } from '../testing/catalog-fixtures';
import { PublicCatalogUseCases } from './public-catalog.use-cases';

function setup() {
  const memory = new CatalogMemory();
  const catalog = seedMaison(memory);
  return { memory, catalog, useCases: new PublicCatalogUseCases(memory.deps()) };
}

describe('UC-NT-01 — catalogue public (R-CA-12)', () => {
  it('catégories et lieux visibles, sans prix', async () => {
    const { memory, catalog, useCases } = setup();
    memory.placeTypes.set('hidden', {
      ...memory.placeTypes.get(catalog.placeTypeId)!,
      id: 'hidden',
      code: 'studio',
      name: 'Studio',
      active: false,
    });
    const listed = await useCases.listCatalog();
    expect(
      listed.map((entry) => [entry.category.code, entry.placeTypes.map((placeType) => placeType.code)]),
    ).toEqual([['maison', ['villa']]]);
  });

  it('détail d’un lieu : paramètres et offres actifs, valeurs de choix actives, frais par défaut', async () => {
    const { memory, catalog, useCases } = setup();
    const salete = memory.parameters.get(catalog.parameterIds.salete as string);
    if (salete) salete.choices[1] = { code: 'apres_travaux', label: 'après travaux', active: false };
    (memory.parameters.get(catalog.parameterIds.chambres as string) as { active: boolean }).active = false;
    const detail = await useCases.getPlaceType(catalog.placeTypeId);
    expect(detail.parameters.map((parameter) => parameter.code)).toEqual([
      'superficie',
      'cour',
      'arriere_cour',
      'salete',
    ]);
    expect(detail.parameters[3]?.choices).toEqual([{ code: 'normal', label: 'normal', active: true }]);
    expect(
      detail.offers.map((offer) => [offer.cleaningType.code, offer.extraParameters.map((p) => p.code)]),
    ).toEqual([
      ['sol', []],
      ['vitres', ['fenetres']],
    ]);
    expect(detail.visitFee).toBe(5000);
    (memory.categories.get(catalog.categoryId) as { visitFee: number | null }).visitFee = 7000;
    expect((await useCases.getPlaceType(catalog.placeTypeId)).visitFee).toBe(7000);
  });

  it('lieu masqué ou inconnu : introuvable', async () => {
    const { memory, catalog, useCases } = setup();
    await expect(useCases.getPlaceType('x')).rejects.toMatchObject({ code: 'CLEANING_PLACE_TYPE_NOT_FOUND' });
    for (const offer of memory.offers.values()) offer.active = false;
    await expect(useCases.getPlaceType(catalog.placeTypeId)).rejects.toMatchObject({
      code: 'CLEANING_PLACE_TYPE_NOT_FOUND',
    });
    expect(await useCases.listCatalog()).toEqual([]);
  });

  it('zones desservies : actives, par nom', async () => {
    const { memory, useCases } = setup();
    memory.zones.set('z2', {
      id: 'z2',
      communeKey: 'abomey-calavi',
      name: 'Abomey-Calavi',
      coefficientBps: 10_500,
      visitFeeSurcharge: 1000,
      planningMode: null,
      active: true,
      updatedAt: NOW,
      updatedBy: null,
    });
    memory.zones.set('z3', {
      ...memory.zones.get('z2')!,
      id: 'z3',
      communeKey: 'parakou',
      name: 'Parakou',
      active: false,
    });
    expect((await useCases.listServedZones()).map((zone) => zone.communeKey)).toEqual([
      'abomey-calavi',
      'cotonou',
    ]);
  });
});
