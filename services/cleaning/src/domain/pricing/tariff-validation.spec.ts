import { type TariffDraft, tariffProblems } from './tariff-validation';
import { type ParameterDefinition } from './types';

const number = (code: string, patch: Partial<ParameterDefinition> = {}): ParameterDefinition => ({
  code,
  kind: 'number',
  min: 0,
  max: 1_000_000,
  choices: [],
  required: false,
  active: true,
  ...patch,
});

const asked: ParameterDefinition[] = [
  number('superficie', { min: 0, max: 5000, required: true }),
  number('chambres'),
  { ...number('cour'), kind: 'boolean', min: null, max: null },
  { ...number('arriere_cour'), kind: 'boolean', min: null, max: null },
  {
    ...number('salete'),
    kind: 'choice',
    min: null,
    max: null,
    choices: [
      { code: 'normal', active: true },
      { code: 'apres_travaux', active: true },
      { code: 'ancien', active: false },
    ],
  },
];

/** Maison × Sol, exemple de la partie 4. */
const sol = (patch: Partial<TariffDraft> = {}): TariffDraft => ({
  baseParameterCode: 'superficie',
  brackets: [
    { from: 0, to: 50, mode: 'flat', amount: 10_000 },
    { from: 51, to: 150, mode: 'per_unit', amount: 180 },
    { from: 151, to: 400, mode: 'per_unit', amount: 150 },
  ],
  supplements: [
    {
      parameterCode: 'cour',
      choiceCode: null,
      mode: 'fixed',
      amount: 5000,
      coefficientBps: null,
      includedUnits: 0,
    },
    {
      parameterCode: 'arriere_cour',
      choiceCode: null,
      mode: 'fixed',
      amount: 3000,
      coefficientBps: null,
      includedUnits: 0,
    },
    {
      parameterCode: 'chambres',
      choiceCode: null,
      mode: 'per_unit',
      amount: 1500,
      coefficientBps: null,
      includedUnits: 3,
    },
    {
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
  ...patch,
});

const context = { askedParameters: asked, isPack: false };
const incomplete = (reason: string, index: number | null) => ({
  code: 'CLEANING_TARIFF_INCOMPLETE',
  reason,
  index,
});
const invalid = (field: string, reason: string) => ({ code: 'CLEANING_VALIDATION_FAILED', field, reason });

describe('tranches contiguës (R-CA-07, R-CA-08, R-CA-11)', () => {
  it('accepte le tarif « Maison × Sol » de la partie 4, en brouillon comme à la publication', () => {
    expect(tariffProblems(sol(), context, 'draft')).toEqual([]);
    expect(tariffProblems(sol(), context, 'publish')).toEqual([]);
  });

  it('accepte une tranche réduite à une seule valeur', () => {
    const brackets = [
      { from: 0, to: 0, mode: 'flat' as const, amount: 0 },
      { from: 1, to: 1, mode: 'flat' as const, amount: 100 },
    ];
    expect(tariffProblems(sol({ brackets }), context, 'publish')).toEqual([]);
  });

  it('refuse des tranches qui se chevauchent, avec le rang de la tranche', () => {
    const brackets = [
      { from: 0, to: 50, mode: 'flat' as const, amount: 10_000 },
      { from: 50, to: 150, mode: 'per_unit' as const, amount: 180 },
    ];
    expect(tariffProblems(sol({ brackets }), context, 'publish')).toEqual([
      incomplete('brackets_overlap', 1),
    ]);
  });

  it('refuse un trou entre deux tranches, même d’une seule unité', () => {
    const brackets = [
      { from: 0, to: 50, mode: 'flat' as const, amount: 10_000 },
      { from: 52, to: 150, mode: 'per_unit' as const, amount: 180 },
    ];
    expect(tariffProblems(sol({ brackets }), context, 'draft')).toEqual([incomplete('brackets_gap', 1)]);
  });

  it('refuse des tranches dans le désordre comme un chevauchement', () => {
    const brackets = [
      { from: 0, to: 50, mode: 'flat' as const, amount: 10_000 },
      { from: 151, to: 400, mode: 'per_unit' as const, amount: 150 },
      { from: 51, to: 150, mode: 'per_unit' as const, amount: 180 },
    ];
    expect(tariffProblems(sol({ brackets }), context, 'draft')).toEqual([
      incomplete('brackets_gap', 1),
      incomplete('brackets_overlap', 2),
    ]);
  });

  it('refuse une première tranche au-dessus de la borne basse du paramètre de base', () => {
    const brackets = [{ from: 1, to: 50, mode: 'flat' as const, amount: 10_000 }];
    expect(tariffProblems(sol({ brackets }), context, 'draft')).toEqual([
      incomplete('first_bracket_above_min', 0),
    ]);
    const withMin = [number('superficie', { min: 1 }), ...asked.slice(1)];
    expect(tariffProblems(sol({ brackets }), { ...context, askedParameters: withMin }, 'draft')).toEqual([]);
  });

  it('prend 0 comme borne basse d’un paramètre sans minimum', () => {
    const withoutMin = [number('superficie', { min: null }), ...asked.slice(1)];
    const brackets = [{ from: 1, to: 50, mode: 'flat' as const, amount: 10_000 }];
    expect(tariffProblems(sol({ brackets }), { ...context, askedParameters: withoutMin }, 'draft')).toEqual([
      incomplete('first_bracket_above_min', 0),
    ]);
  });

  it('accepte un brouillon sans tranche mais refuse de le publier', () => {
    expect(tariffProblems(sol({ brackets: [] }), context, 'draft')).toEqual([]);
    expect(tariffProblems(sol({ brackets: [] }), context, 'publish')).toEqual([
      incomplete('brackets_gap', 0),
    ]);
  });

  it('contrôle les bornes et le montant de chaque tranche', () => {
    const brackets = [
      { from: 0, to: 50, mode: 'flat' as const, amount: 100_000_001 },
      { from: 51, to: 50, mode: 'per_unit' as const, amount: 180 },
      { from: 51, to: 1_000_001, mode: 'per_unit' as const, amount: 180 },
    ];
    expect(tariffProblems(sol({ brackets }), context, 'draft')).toEqual([
      invalid('brackets[0].amount', 'out_of_range'),
      invalid('brackets[1].to', 'out_of_range'),
      invalid('brackets[2].to', 'out_of_range'),
    ]);
  });
});

describe('paramètre de base (R-CA-11, R-CA-14)', () => {
  it('refuse une base qui n’est pas un nombre', () => {
    expect(tariffProblems(sol({ baseParameterCode: 'cour' }), context, 'draft')).toEqual([
      incomplete('base_not_number', null),
    ]);
  });

  it('refuse une base désactivée', () => {
    const inactive = [number('superficie', { active: false }), ...asked.slice(1)];
    expect(tariffProblems(sol(), { ...context, askedParameters: inactive }, 'draft')).toEqual([
      incomplete('base_inactive', null),
    ]);
  });

  it('refuse une base demandée ni par le lieu ni par l’offre', () => {
    expect(tariffProblems(sol({ baseParameterCode: 'surface_jardin' }), context, 'draft')).toEqual([
      incomplete('base_not_asked', null),
    ]);
  });

  it('exige une base pour un tarif par tranches', () => {
    expect(tariffProblems(sol({ baseParameterCode: null }), context, 'draft')).toEqual([
      invalid('baseParameterCode', 'required'),
    ]);
  });
});

describe('suppléments (R-CA-11, partie 4)', () => {
  const supplement = sol().supplements;

  it('refuse un supplément sur un paramètre non demandé', () => {
    const supplements = [{ ...supplement[0]!, parameterCode: 'piscine' }];
    expect(tariffProblems(sol({ supplements }), context, 'draft')).toEqual([
      incomplete('supplement_parameter_not_asked', 0),
    ]);
  });

  it('refuse une valeur de choix inconnue, mais accepte une valeur désactivée', () => {
    const unknown = [{ ...supplement[3]!, choiceCode: 'boueux' }];
    expect(tariffProblems(sol({ supplements: unknown }), context, 'draft')).toEqual([
      incomplete('unknown_choice', 0),
    ]);
    const inactive = [{ ...supplement[3]!, choiceCode: 'ancien' }];
    expect(tariffProblems(sol({ supplements: inactive }), context, 'draft')).toEqual([]);
  });

  it('refuse un supplément de choix sans valeur, ou une valeur sur un autre paramètre', () => {
    const withoutChoice = [{ ...supplement[3]!, choiceCode: null }];
    expect(tariffProblems(sol({ supplements: withoutChoice }), context, 'draft')).toEqual([
      incomplete('unknown_choice', 0),
    ]);
    const choiceOnBoolean = [{ ...supplement[0]!, choiceCode: 'oui' }];
    expect(tariffProblems(sol({ supplements: choiceOnBoolean }), context, 'draft')).toEqual([
      incomplete('unknown_choice', 0),
    ]);
  });

  it('réserve le mode par unité aux nombres', () => {
    const perUnitYes = [{ ...supplement[0]!, mode: 'per_unit' as const }];
    expect(tariffProblems(sol({ supplements: perUnitYes }), context, 'draft')).toEqual([
      incomplete('mode_incompatible', 0),
    ]);
    const coefficientYes = [
      { ...supplement[0]!, mode: 'coefficient' as const, amount: null, coefficientBps: 11_000 },
    ];
    expect(tariffProblems(sol({ supplements: coefficientYes }), context, 'draft')).toEqual([]);
  });

  it('contrôle montant, coefficient et unités incluses selon le mode', () => {
    const supplements = [
      { ...supplement[0]!, amount: null },
      { ...supplement[0]!, coefficientBps: 9000 },
      { ...supplement[3]!, coefficientBps: 100_001 },
      { ...supplement[3]!, coefficientBps: null },
      { ...supplement[3]!, amount: 100 },
      { ...supplement[2]!, includedUnits: 1_000_001 },
      { ...supplement[0]!, includedUnits: 2 },
    ];
    expect(tariffProblems(sol({ supplements }), context, 'draft')).toEqual([
      invalid('supplements[0].amount', 'required'),
      invalid('supplements[1].coefficientBps', 'not_applicable'),
      invalid('supplements[2].coefficientBps', 'out_of_range'),
      invalid('supplements[3].coefficientBps', 'required'),
      invalid('supplements[4].amount', 'not_applicable'),
      invalid('supplements[5].includedUnits', 'out_of_range'),
      invalid('supplements[6].includedUnits', 'not_applicable'),
    ]);
  });

  it('accepte les bornes incluses : coefficient 1 et 100 000, unités incluses 1 000 000', () => {
    const supplements = [
      { ...supplement[3]!, coefficientBps: 1 },
      { ...supplement[3]!, coefficientBps: 100_000 },
      { ...supplement[2]!, includedUnits: 1_000_000 },
    ];
    expect(tariffProblems(sol({ supplements }), context, 'draft')).toEqual([]);
  });
});

describe('remise récurrente et minimum (R-PX-06, R-PX-02)', () => {
  it('accepte weekly, monthly et every_N_weeks pour N de 2 à 12', () => {
    const frequencyCoefficients = ['weekly', 'monthly', 'every_2_weeks', 'every_12_weeks'].map((key) => ({
      key,
      coefficientBps: 9000,
    }));
    expect(tariffProblems(sol({ frequencyCoefficients }), context, 'draft')).toEqual([]);
  });

  it('refuse une clé inconnue, every_1_weeks, every_13_weeks, une clé en double, un coefficient hors bornes', () => {
    const frequencyCoefficients = [
      { key: 'daily', coefficientBps: 9000 },
      { key: 'every_1_weeks', coefficientBps: 9000 },
      { key: 'every_13_weeks', coefficientBps: 9000 },
      { key: 'weekly', coefficientBps: 9000 },
      { key: 'weekly', coefficientBps: 9500 },
      { key: 'monthly', coefficientBps: 0 },
    ];
    expect(tariffProblems(sol({ frequencyCoefficients }), context, 'draft')).toEqual([
      invalid('frequencyCoefficients[0].key', 'invalid_type'),
      invalid('frequencyCoefficients[1].key', 'invalid_type'),
      invalid('frequencyCoefficients[2].key', 'invalid_type'),
      invalid('frequencyCoefficients[4].key', 'duplicate'),
      invalid('frequencyCoefficients[5].coefficientBps', 'out_of_range'),
    ]);
  });

  it('accepte un minimum de 0 et refuse un minimum négatif', () => {
    expect(tariffProblems(sol({ minimum: 0 }), context, 'draft')).toEqual([]);
    expect(tariffProblems(sol({ minimum: -1 }), context, 'draft')).toEqual([
      invalid('minimum', 'out_of_range'),
    ]);
  });
});

describe('pack à remise (R-CA-04)', () => {
  const pack = (patch: Partial<TariffDraft> = {}): TariffDraft =>
    sol({
      baseParameterCode: null,
      brackets: [],
      supplements: [],
      frequencyCoefficients: [],
      packDiscountBps: 1000,
      ...patch,
    });
  const packContext = { askedParameters: asked, isPack: true };

  it('accepte une remise de 0 à 90 %', () => {
    expect(tariffProblems(pack({ packDiscountBps: 0 }), packContext, 'publish')).toEqual([]);
    expect(tariffProblems(pack({ packDiscountBps: 9000 }), packContext, 'publish')).toEqual([]);
  });

  it('refuse une remise de 95 %', () => {
    expect(tariffProblems(pack({ packDiscountBps: 9500 }), packContext, 'draft')).toEqual([
      invalid('packDiscountBps', 'out_of_range'),
    ]);
  });

  it('refuse une remise sur l’offre d’un type qui n’est pas un pack', () => {
    expect(tariffProblems(pack(), context, 'draft')).toEqual([invalid('packDiscountBps', 'not_applicable')]);
  });

  it('refuse une remise avec une base, des tranches, des suppléments ou une remise récurrente', () => {
    const mixed = pack({
      baseParameterCode: 'superficie',
      brackets: sol().brackets,
      supplements: sol().supplements,
      frequencyCoefficients: sol().frequencyCoefficients,
    });
    expect(tariffProblems(mixed, packContext, 'draft')).toEqual([
      invalid('baseParameterCode', 'not_applicable'),
      invalid('brackets', 'not_applicable'),
      invalid('supplements', 'not_applicable'),
      invalid('frequencyCoefficients', 'not_applicable'),
    ]);
  });

  it('accepte un pack à prix propre par tranches', () => {
    expect(tariffProblems(sol(), packContext, 'publish')).toEqual([]);
  });
});
