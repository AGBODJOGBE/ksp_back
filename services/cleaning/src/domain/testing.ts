import { type FieldChoice, type FormField, type ServiceDefinition } from './catalog';

/**
 * Prestations d'exemple, avec des prix fixés, pour les tests (domaine, application, gRPC).
 * Les données de départ réelles sont créées par la migration 0007, prix à null.
 */
const NOW = new Date('2026-10-01T00:00:00Z');

const blank = {
  helpText: null,
  unitLabel: null,
  min: null,
  max: null,
  pricePerUnit: null,
  choices: [],
  supplementIfYes: null,
  coefficientBpIfYes: null,
};

export function numberField(
  code: string,
  label: string,
  unitLabel: string,
  pricePerUnit: number | null,
  extra: Partial<FormField> = {},
): FormField {
  return {
    ...blank,
    code,
    label,
    type: 'number',
    required: true,
    active: true,
    unitLabel,
    min: 1,
    max: 1000,
    pricePerUnit,
    ...extra,
  };
}

/** Valeurs : [code, libellé, supplément, coefficient]. */
export function choiceField(
  code: string,
  label: string,
  values: [string, string, number | null, number | null][],
  extra: Partial<FormField> = {},
): FormField {
  const choices: FieldChoice[] = values.map(([value, text, supplement, coefficientBp]) => ({
    code: value,
    label: text,
    supplement,
    coefficientBp,
    active: true,
  }));
  return { ...blank, code, label, type: 'choice', required: true, active: true, choices, ...extra };
}

export function booleanField(
  code: string,
  label: string,
  supplementIfYes: number | null,
  coefficientBpIfYes: number | null,
  extra: Partial<FormField> = {},
): FormField {
  return {
    ...blank,
    code,
    label,
    type: 'boolean',
    required: false,
    active: true,
    supplementIfYes,
    coefficientBpIfYes,
    ...extra,
  };
}

const FREQUENCIES = [
  { code: 'once', label: 'Une fois', coefficientBp: 10_000, active: true },
  { code: 'weekly', label: 'Chaque semaine', coefficientBp: 9_000, active: true },
  { code: 'monthly', label: 'Chaque mois', coefficientBp: 9_500, active: true },
];

/** Nettoyage à domicile, grille complète. */
export function homeCleaningService(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    code: 'home_cleaning',
    name: 'Nettoyage à domicile',
    description: 'Ménage complet du logement.',
    unit: 'room',
    active: true,
    fields: [
      choiceField('housing_type', 'Type de logement', [
        ['studio', 'Studio', 0, null],
        ['apartment', 'Appartement', 0, null],
        ['villa', 'Villa', 5000, null],
      ]),
      numberField('rooms', 'Nombre de pièces', 'pièces', 4500, { max: 50 }),
      numberField('bathrooms', 'Nombre de salles de bain', 'salles de bain', 3000, { min: 0, max: 20 }),
      choiceField('condition', 'État', [
        ['normal', 'Normal', 0, null],
        ['dirty', 'Sale', null, 12_000],
        ['very_dirty', 'Très sale', null, 15_000],
      ]),
      booleanField('pets', "Présence d'animaux", null, 11_000),
    ],
    options: [
      {
        code: 'windows',
        label: 'Vitres',
        description: null,
        active: true,
        flatPrice: null,
        fields: [numberField('window_count', 'Nombre de fenêtres', 'fenêtres', 500, { max: 200 })],
      },
      {
        code: 'sofa',
        label: 'Canapé',
        description: null,
        active: true,
        flatPrice: null,
        fields: [numberField('seats', 'Nombre de places', 'places', 2000, { max: 20 })],
      },
      {
        code: 'appliances',
        label: 'Électroménager',
        description: null,
        active: true,
        flatPrice: 5000,
        fields: [],
      },
    ],
    pricing: {
      version: 3,
      minimumPrice: 15_000,
      communeCoefficients: { 'abomey-calavi': 10_500 },
      defaultCoefficientBp: 10_000,
      frequencies: FREQUENCIES,
      teamSize: { fieldCode: 'rooms', unitsPerAgent: 3, minAgents: 1, maxAgents: 6 },
      checklist: [],
      updatedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001',
      updatedAt: NOW,
    },
    ...overrides,
  };
}

/** Entretien de jardin : option avec un champ à coefficient (limité à l'option). */
export function gardenService(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    code: 'garden_maintenance',
    name: 'Entretien de jardin',
    description: 'Tonte, désherbage et entretien des espaces verts.',
    unit: 'square_meter',
    active: true,
    fields: [
      numberField('surface', 'Superficie', 'm²', 150, { max: 100_000 }),
      choiceField('condition', 'État de la pelouse ou du jardin', [
        ['maintained', 'Entretenu', 0, null],
        ['overgrown', 'Envahi', null, 13_000],
        ['very_overgrown', 'Très envahi', null, 16_000],
      ]),
    ],
    options: [
      {
        code: 'hedge_trimming',
        label: 'Taille de haies',
        description: null,
        active: true,
        flatPrice: null,
        fields: [
          numberField('hedge_length', 'Longueur de haies', 'mètres linéaires', 500, { max: 2000 }),
          choiceField(
            'hedge_height',
            'Hauteur',
            [
              ['low', 'Basse', null, 10_000],
              ['high', 'Haute', null, 15_000],
            ],
            { required: false },
          ),
        ],
      },
      {
        code: 'green_waste_removal',
        label: 'Évacuation des déchets verts',
        description: null,
        active: true,
        flatPrice: 10_000,
        fields: [],
      },
    ],
    pricing: {
      version: 2,
      minimumPrice: 15_000,
      communeCoefficients: { cotonou: 10_000 },
      defaultCoefficientBp: 10_000,
      frequencies: [
        FREQUENCIES[0]!,
        { code: 'weekly', label: 'Chaque semaine', coefficientBp: 8_500, active: true },
        { code: 'monthly', label: 'Chaque mois', coefficientBp: 9_000, active: true },
      ],
      teamSize: { fieldCode: 'surface', unitsPerAgent: 300, minAgents: 1, maxAgents: 6 },
      checklist: [],
      updatedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0001',
      updatedAt: NOW,
    },
    ...overrides,
  };
}
