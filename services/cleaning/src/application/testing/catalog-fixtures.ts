import { type Offer, type Parameter, type TariffVersion } from '../catalog/catalog.ports';
import { type TariffFields } from '../catalog/tariffs.use-cases';
import { type CatalogMemory, NOW } from './catalog-fakes';

/**
 * Catalogue de la partie 4 en mémoire : catégorie « Maison », lieu « Villa » (superficie, chambres,
 * cour, arrière-cour, niveau de saleté), types « Sol » et « Vitres » (fenêtres, paramètre propre de
 * l'offre), offres actives sans tarif. Montants fictifs du cahier des charges.
 */
export interface MaisonCatalog {
  categoryId: string;
  placeTypeId: string;
  solTypeId: string;
  vitresTypeId: string;
  solOfferId: string;
  vitresOfferId: string;
  parameterIds: Record<string, string>;
}

function parameter(
  memory: CatalogMemory,
  patch: Partial<Parameter> & Pick<Parameter, 'code' | 'kind'>,
): string {
  const id = memory.nextId();
  memory.parameters.set(id, {
    id,
    label: patch.code,
    unit: null,
    min: null,
    max: null,
    choices: [],
    required: false,
    help: null,
    active: true,
    updatedAt: NOW,
    updatedBy: null,
    ...patch,
  });
  return id;
}

export function seedMaison(memory: CatalogMemory): MaisonCatalog {
  const ids = {
    superficie: parameter(memory, {
      code: 'superficie',
      label: 'superficie',
      kind: 'number',
      unit: 'm²',
      min: 0,
      max: 5000,
      required: true,
    }),
    chambres: parameter(memory, {
      code: 'chambres',
      label: 'chambres',
      kind: 'number',
      unit: 'chambres',
      min: 0,
      max: 50,
    }),
    cour: parameter(memory, { code: 'cour', label: 'cour', kind: 'boolean' }),
    arriere_cour: parameter(memory, { code: 'arriere_cour', label: 'arrière-cour', kind: 'boolean' }),
    salete: parameter(memory, {
      code: 'salete',
      label: 'niveau de saleté',
      kind: 'choice',
      choices: [
        { code: 'normal', label: 'normal', active: true },
        { code: 'apres_travaux', label: 'après travaux', active: true },
      ],
    }),
    fenetres: parameter(memory, {
      code: 'fenetres',
      label: 'fenêtres',
      kind: 'number',
      unit: 'fenêtres',
      min: 1,
      max: 200,
      required: true,
    }),
  };
  const categoryId = memory.nextId();
  memory.categories.set(categoryId, {
    id: categoryId,
    code: 'maison',
    name: 'Maison',
    icon: 'house',
    order: 0,
    active: true,
    visitFee: null,
    updatedAt: NOW,
    updatedBy: null,
  });
  const placeTypeId = memory.nextId();
  memory.placeTypes.set(placeTypeId, {
    id: placeTypeId,
    code: 'villa',
    categoryId,
    name: 'Villa',
    icon: 'villa',
    photoFileId: null,
    description: null,
    order: 0,
    active: true,
    isOther: false,
    parameters: ['superficie', 'chambres', 'cour', 'arriere_cour', 'salete'].map((code) => ({
      parameterId: ids[code as keyof typeof ids],
      code,
    })),
    areaParameterId: ids.superficie,
    updatedAt: NOW,
    updatedBy: null,
  });
  memory.skills.set('skill-1', {
    id: 'skill-1',
    code: 'interieur',
    name: 'Nettoyage intérieur',
    active: true,
  });
  const type = (code: string, name: string, minutes: number) => {
    const id = memory.nextId();
    memory.cleaningTypes.set(id, {
      id,
      code,
      name,
      description: null,
      icon: null,
      requiredSkillCode: 'interieur',
      referenceDurationMinutes: minutes,
      checklist: [],
      isPack: false,
      packItemIds: [],
      active: true,
      updatedAt: NOW,
      updatedBy: null,
    });
    return id;
  };
  const solTypeId = type('sol', 'Sol', 180);
  const vitresTypeId = type('vitres', 'Vitres', 60);
  const offer = (cleaningTypeId: string, extra: string[], teamRule: Offer['teamRule']) => {
    const id = memory.nextId();
    memory.offers.set(id, {
      id,
      placeTypeId,
      cleaningTypeId,
      extraParameters: extra.map((code) => ({ parameterId: ids[code as keyof typeof ids], code })),
      teamRule,
      order: 0,
      active: true,
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy: null,
    });
    return id;
  };
  const solOfferId = offer(
    solTypeId,
    [],
    [
      { fromArea: 0, toArea: 100, agents: 2, durationMinutes: 180 },
      { fromArea: 101, toArea: null, agents: 3, durationMinutes: 240 },
    ],
  );
  const vitresOfferId = offer(vitresTypeId, ['fenetres'], []);
  memory.zones.set('zone-cotonou', {
    id: 'zone-cotonou',
    communeKey: 'cotonou',
    name: 'Cotonou',
    coefficientBps: 10_000,
    visitFeeSurcharge: null,
    planningMode: null,
    active: true,
    updatedAt: NOW,
    updatedBy: null,
  });
  return { categoryId, placeTypeId, solTypeId, vitresTypeId, solOfferId, vitresOfferId, parameterIds: ids };
}

/** Tarif « Maison × Sol » de la partie 4 : 3 tranches, suppléments, minimum, remise hebdomadaire. */
export const SOL_TARIFF: TariffFields = {
  baseParameterCode: 'superficie',
  brackets: [
    { from: 0, to: 50, mode: 'flat', amount: 10_000 },
    { from: 51, to: 150, mode: 'per_unit', amount: 180 },
    { from: 151, to: 400, mode: 'per_unit', amount: 150 },
  ],
  supplements: [
    { parameterCode: 'cour', mode: 'fixed', amount: 5000 },
    { parameterCode: 'arriere_cour', mode: 'fixed', amount: 3000 },
    { parameterCode: 'chambres', mode: 'per_unit', amount: 1500, includedUnits: 3 },
    { parameterCode: 'salete', choiceCode: 'apres_travaux', mode: 'coefficient', coefficientBps: 13_000 },
  ],
  minimum: 10_000,
  frequencyCoefficients: [{ key: 'weekly', coefficientBps: 9000 }],
};

/** Tarif « Maison × Vitres » de l'exemple de la partie 5 : 500 FCFA par fenêtre de 1 à 20. */
export const VITRES_TARIFF: TariffFields = {
  baseParameterCode: 'fenetres',
  brackets: [{ from: 1, to: 20, mode: 'per_unit', amount: 500 }],
  supplements: [],
  minimum: 3000,
  frequencyCoefficients: [{ key: 'weekly', coefficientBps: 9000 }],
};

/** Version publiée d'un tarif, posée directement en mémoire. */
export function publishedTariff(memory: CatalogMemory, offerId: string, tariff: TariffVersion): void {
  memory.tariffs.set(tariff.id, {
    ...tariff,
    offerId,
    status: 'published',
    publishedAt: NOW,
    publishedBy: 'a',
  });
}
