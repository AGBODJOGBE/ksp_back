import { type ServiceDefinition } from './catalog';
import { type CalculationInput, calculatePrice, priceRange, quoteLinesFrom } from './simulator';
import { choiceField, gardenService, homeCleaningService, numberField } from './testing';

const home = (input: Partial<CalculationInput> = {}, service = homeCleaningService()) =>
  calculatePrice(service, {
    answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal', pets: false },
    options: [{ code: 'windows', answers: { window_count: 8 } }],
    frequency: 'once',
    commune: 'Abomey-Calavi',
    ...input,
  });

const withField = (service: ServiceDefinition, code: string, patch: object): ServiceDefinition => ({
  ...service,
  fields: service.fields.map((field) => (field.code === code ? { ...field, ...patch } : field)),
});

describe('calcul du prix d’un passage', () => {
  it('nombre × prix par unité, options, coefficients de la commune et de la fréquence', () => {
    const result = home();
    expect(result).toMatchObject({
      pricingVersion: 3,
      priced: true,
      reason: null,
      missingPrices: [],
      baseAmount: 34_000,
      subtotal: 35_700,
      minimumPrice: 15_000,
      minimumApplied: false,
      computedPrice: 35_700,
      estimate: { low: 32_000, high: 41_000 },
      recommendedTeamSize: 2,
    });
    expect(result.lines).toEqual([
      {
        kind: 'unit_price',
        optionCode: null,
        fieldCode: 'rooms',
        choiceCode: null,
        label: 'Nombre de pièces',
        quantity: 6,
        unitLabel: 'pièces',
        unitPrice: 4500,
        amount: 27_000,
      },
      expect.objectContaining({ fieldCode: 'bathrooms', quantity: 1, amount: 3000 }),
      expect.objectContaining({
        kind: 'unit_price',
        optionCode: 'windows',
        fieldCode: 'window_count',
        label: 'Vitres — nombre de fenêtres',
        quantity: 8,
        amount: 4000,
      }),
    ]);
    expect(result.coefficients).toEqual([
      {
        source: 'commune',
        optionCode: null,
        fieldCode: null,
        code: 'abomey-calavi',
        label: 'Abomey-Calavi',
        coefficientBp: 10_500,
      },
      {
        source: 'frequency',
        optionCode: null,
        fieldCode: null,
        code: 'once',
        label: 'Une fois',
        coefficientBp: 10_000,
      },
    ]);
  });

  it('suppléments des valeurs choisies, coefficients des choix et des réponses oui, fréquence', () => {
    const result = home({
      answers: { housing_type: 'villa', rooms: 4, bathrooms: 2, condition: 'dirty', pets: true },
      options: [],
      frequency: 'weekly',
      commune: 'Cotonou',
    });
    expect(result.lines.map((line) => [line.kind, line.label, line.amount])).toEqual([
      ['supplement', 'Type de logement : villa', 5000],
      ['unit_price', 'Nombre de pièces', 18_000],
      ['unit_price', 'Nombre de salles de bain', 6000],
    ]);
    expect(result.coefficients.map((c) => [c.source, c.code, c.coefficientBp])).toEqual([
      ['choice', 'dirty', 12_000],
      ['boolean', null, 11_000],
      ['commune', 'cotonou', 10_000],
      ['frequency', 'weekly', 9_000],
    ]);
    // 29 000 × 1,2 × 1,1 × 1 × 0,9
    expect(result).toMatchObject({ baseAmount: 29_000, subtotal: 34_452, computedPrice: 34_452 });
  });

  it('les coefficients des champs d’une option ne s’appliquent qu’à cette option', () => {
    const result = calculatePrice(gardenService(), {
      answers: { surface: 400, condition: 'maintained' },
      options: [
        { code: 'hedge_trimming', answers: { hedge_length: 20, hedge_height: 'high' } },
        { code: 'green_waste_removal', answers: {} },
      ],
      frequency: 'monthly',
      commune: 'Cotonou',
    });
    expect(result.coefficients[0]).toEqual({
      source: 'choice',
      optionCode: 'hedge_trimming',
      fieldCode: 'hedge_height',
      code: 'high',
      label: 'Taille de haies — hauteur : haute',
      coefficientBp: 15_000,
    });
    // (60 000 + 10 000 × 1,5 + 10 000) × 0,9 — et non 80 000 × 1,5 × 0,9.
    expect(result).toMatchObject({ baseAmount: 80_000, subtotal: 76_500, computedPrice: 76_500 });
    expect(result.lines.map((line) => [line.kind, line.optionCode, line.amount])).toEqual([
      ['unit_price', null, 60_000],
      ['unit_price', 'hedge_trimming', 10_000],
      ['flat_price', 'green_waste_removal', 10_000],
    ]);
  });

  it('arrondit une seule fois, à la fin, au franc le plus proche', () => {
    const service: ServiceDefinition = {
      ...gardenService(),
      fields: [
        numberField('surface', 'Superficie', 'm²', 333),
        choiceField('condition', 'État', [['overgrown', 'Envahi', null, 10_500]]),
      ],
      options: [],
      pricing: {
        ...gardenService().pricing,
        minimumPrice: null,
        communeCoefficients: { cotonou: 10_500 },
        frequencies: [],
      },
    };
    const result = calculatePrice(service, {
      answers: { surface: 1, condition: 'overgrown' },
      options: [],
      frequency: null,
      commune: 'Cotonou',
    });
    // 333 × 1,05 × 1,05 = 367,13 → 367 (deux arrondis successifs donneraient 368).
    expect(result.computedPrice).toBe(367);
  });

  it('applique le minimum de commande', () => {
    const result = home({
      answers: { housing_type: 'studio', rooms: 1, bathrooms: 0, condition: 'normal' },
      options: [],
      commune: 'Cotonou',
    });
    expect(result).toMatchObject({
      subtotal: 4500,
      computedPrice: 15_000,
      minimumApplied: true,
      estimate: priceRange(15_000),
    });
  });

  it('commune inconnue : coefficient par défaut', () => {
    expect(home({ commune: 'Ouidah' }).coefficients[0]).toMatchObject({
      code: 'ouidah',
      coefficientBp: 10_000,
    });
  });

  it('un prix à 0 est sans effet, un prix null manque', () => {
    const free = withField(homeCleaningService(), 'bathrooms', { pricePerUnit: 0 });
    expect(home({}, free)).toMatchObject({ priced: true, baseAmount: 31_000 });

    const unpriced = home({}, withField(homeCleaningService(), 'rooms', { pricePerUnit: null }));
    expect(unpriced).toMatchObject({
      priced: false,
      reason: 'price_not_set',
      missingPrices: [{ optionCode: null, fieldCode: 'rooms', choiceCode: null }],
      baseAmount: null,
      subtotal: null,
      computedPrice: null,
      estimate: null,
      minimumApplied: false,
      recommendedTeamSize: 2,
    });
  });

  it('valeur choisie ou réponse oui sans supplément ni coefficient : prix manquant', () => {
    const service = withField(
      withField(homeCleaningService(), 'pets', { coefficientBpIfYes: null }),
      'condition',
      {
        choices: [{ code: 'normal', label: 'Normal', supplement: null, coefficientBp: null, active: true }],
      },
    );
    expect(
      home(
        { answers: { housing_type: 'studio', rooms: 2, bathrooms: 0, condition: 'normal', pets: true } },
        service,
      ),
    ).toMatchObject({
      priced: false,
      reason: 'price_not_set',
      missingPrices: [
        { optionCode: null, fieldCode: 'condition', choiceCode: 'normal' },
        { optionCode: null, fieldCode: 'pets', choiceCode: null },
      ],
    });
  });

  it('prix d’une option manquant : forfait d’une option sans champ, ou prix de ses champs', () => {
    const service = homeCleaningService();
    service.options[2]!.flatPrice = null;
    service.options[0]!.fields[0]!.pricePerUnit = null;
    expect(home({ options: [{ code: 'appliances', answers: {} }] }, service)).toMatchObject({
      priced: false,
      reason: 'option_price_not_set',
      missingPrices: [{ optionCode: 'appliances', fieldCode: null, choiceCode: null }],
    });
    expect(home({}, service)).toMatchObject({
      reason: 'option_price_not_set',
      missingPrices: [{ optionCode: 'windows', fieldCode: 'window_count', choiceCode: null }],
    });
  });

  it('ancien format incomplet : answers_incomplete, prioritaire', () => {
    const service = withField(homeCleaningService(), 'rooms', { pricePerUnit: null });
    expect(home({ incomplete: true }, service)).toMatchObject({
      priced: false,
      reason: 'answers_incomplete',
    });
  });

  it('taille d’équipe sur le champ désigné, ou celle demandée, dans les bornes', () => {
    expect(home({ answers: { rooms: 7 } }).recommendedTeamSize).toBe(3);
    expect(home({ answers: { rooms: 49 } }).recommendedTeamSize).toBe(6);
    expect(home({ requestedTeamSize: 5 }).recommendedTeamSize).toBe(5);
    const noField = homeCleaningService();
    noField.pricing.teamSize = { ...noField.pricing.teamSize, fieldCode: null, minAgents: 2 };
    expect(home({}, noField).recommendedTeamSize).toBe(2);
  });

  it('version de grille : celle de la prestation, ou null pour une définition essayée', () => {
    expect(home().pricingVersion).toBe(3);
    const input = {
      answers: { surface: 100, condition: 'maintained' },
      options: [],
      frequency: 'once',
      commune: 'Cotonou',
    };
    expect(calculatePrice(gardenService(), input, null).pricingVersion).toBeNull();
  });
});

describe('fourchette et lignes du devis', () => {
  it('fourchette −10 % / +15 % arrondie à 500 FCFA', () => {
    expect(priceRange(37_400)).toEqual({ low: 33_500, high: 43_000 });
  });

  it('préremplit les lignes du devis, avec une ligne d’ajustement', () => {
    expect(quoteLinesFrom(home())).toEqual([
      { label: 'Nombre de pièces', quantity: 6, unitPrice: 4500, amount: 27_000 },
      { label: 'Nombre de salles de bain', quantity: 1, unitPrice: 3000, amount: 3000 },
      { label: 'Vitres — nombre de fenêtres', quantity: 8, unitPrice: 500, amount: 4000 },
      { label: 'Ajustement : Abomey-Calavi', quantity: 1, unitPrice: 1700, amount: 1700 },
    ]);
    const minimum = home({ answers: { rooms: 1, bathrooms: 0 }, options: [], commune: 'Cotonou' });
    expect(quoteLinesFrom(minimum)?.at(-1)).toEqual({
      label: 'Minimum de commande',
      quantity: 1,
      unitPrice: 10_500,
      amount: 10_500,
    });
    expect(quoteLinesFrom({ ...home(), priced: false, computedPrice: null })).toBeNull();
  });
});
