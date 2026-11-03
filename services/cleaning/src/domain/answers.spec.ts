import { checkAnswers, convertLegacy, type FormAnswers, legacyPremisesType, legacyQuantity } from './answers';
import { type ServiceDefinition } from './catalog';
import { choiceField, gardenService, homeCleaningService, numberField } from './testing';

const valid: FormAnswers = {
  answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1, condition: 'normal' },
  options: [{ code: 'windows', answers: { window_count: 8 } }],
  frequency: 'once',
};
const check = (patch: Partial<FormAnswers>, lenient = false) =>
  checkAnswers(homeCleaningService(), { ...valid, ...patch }, lenient);
const problem = (patch: Partial<FormAnswers>) => {
  const result = check(patch);
  return result.ok ? null : result.problem;
};

describe('réponses au formulaire', () => {
  it('accepte des réponses conformes ; un oui/non facultatif peut manquer', () => {
    expect(check({})).toEqual({ ok: true, value: valid, incomplete: false });
  });

  it('refuse un champ inconnu ou inactif', () => {
    expect(problem({ answers: { ...valid.answers, garage: 1 } })).toEqual({
      field: 'answers.garage',
      reason: 'unknown_field',
    });
    const service = homeCleaningService();
    service.fields[2]!.active = false;
    expect(checkAnswers(service, valid)).toEqual({
      ok: false,
      problem: { field: 'answers.bathrooms', reason: 'unknown_field' },
    });
  });

  it('exige les champs obligatoires', () => {
    expect(problem({ answers: { housing_type: 'apartment', rooms: 6, bathrooms: 1 } })).toEqual({
      field: 'answers.condition',
      reason: 'required',
    });
  });

  it('contrôle les types et les bornes', () => {
    expect(problem({ answers: { ...valid.answers, rooms: 2.5 } })).toEqual({
      field: 'answers.rooms',
      reason: 'invalid_type',
    });
    expect(problem({ answers: { ...valid.answers, rooms: '6' } })).toMatchObject({ reason: 'invalid_type' });
    expect(problem({ answers: { ...valid.answers, pets: 'yes' } })).toMatchObject({ reason: 'invalid_type' });
    expect(problem({ answers: { ...valid.answers, condition: 3 } })).toMatchObject({
      reason: 'invalid_type',
    });
    expect(problem({ answers: { ...valid.answers, rooms: 0 } })).toEqual({
      field: 'answers.rooms',
      reason: 'out_of_range',
    });
    expect(problem({ answers: { ...valid.answers, rooms: 51 } })).toMatchObject({ reason: 'out_of_range' });
  });

  it('refuse une valeur inconnue ou inactive', () => {
    expect(problem({ answers: { ...valid.answers, condition: 'muddy' } })).toEqual({
      field: 'answers.condition',
      reason: 'unknown_choice',
    });
    const service = homeCleaningService();
    service.fields[3]!.choices[0]!.active = false;
    expect(checkAnswers(service, valid)).toMatchObject({ ok: false, problem: { reason: 'unknown_choice' } });
  });

  it('contrôle les options et leurs réponses', () => {
    expect(problem({ options: [{ code: 'pool', answers: {} }] })).toEqual({
      field: 'options[0].code',
      reason: 'unknown_option',
    });
    expect(
      problem({
        options: [
          { code: 'appliances', answers: {} },
          { code: 'appliances', answers: {} },
        ],
      }),
    ).toEqual({ field: 'options[1].code', reason: 'duplicate_option' });
    expect(problem({ options: [{ code: 'windows', answers: {} }] })).toEqual({
      field: 'options[0].answers.window_count',
      reason: 'required',
    });
    expect(problem({ options: [{ code: 'windows', answers: { window_count: 500 } }] })).toEqual({
      field: 'options[0].answers.window_count',
      reason: 'out_of_range',
    });
  });

  it('fréquence obligatoire dès que la prestation en a une active ; refusée si inconnue', () => {
    expect(problem({ frequency: null })).toEqual({ field: 'frequency', reason: 'required' });
    expect(problem({ frequency: 'daily' })).toEqual({ field: 'frequency', reason: 'unknown_frequency' });
    const none: ServiceDefinition = { ...homeCleaningService() };
    none.pricing = { ...none.pricing, frequencies: [] };
    expect(checkAnswers(none, { ...valid, frequency: null })).toMatchObject({ ok: true });
    expect(checkAnswers(none, valid)).toMatchObject({ ok: false, problem: { reason: 'unknown_frequency' } });
  });

  it('mode toléré (ancien format) : réponse manquante = incomplet, fréquence inconnue sans effet', () => {
    const result = check(
      { answers: { rooms: 6 }, options: [{ code: 'windows', answers: {} }], frequency: 'daily' },
      true,
    );
    expect(result).toEqual({
      ok: true,
      incomplete: true,
      value: { answers: { rooms: 6 }, options: [{ code: 'windows', answers: {} }], frequency: null },
    });
    expect(check({ answers: { rooms: 99 } }, true)).toMatchObject({
      ok: false,
      problem: { reason: 'out_of_range' },
    });
  });
});

describe('ancien format', () => {
  const pest: ServiceDefinition = {
    ...gardenService(),
    code: 'pest_control',
    fields: [
      numberField('surface', 'Superficie', 'm²', null, { max: 100_000 }),
      choiceField('premises_type', 'Type de local', [
        ['housing', 'Logement', null, null],
        ['office', 'Bureau', null, null],
        ['shop', 'Commerce', null, null],
        ['warehouse', 'Entrepôt', null, null],
      ]),
    ],
  };

  it('convertit la quantité, le type de local, les options et la fréquence', () => {
    expect(
      convertLegacy(homeCleaningService(), {
        premisesType: 'house',
        quantity: 6,
        options: ['windows', 'windows', 'appliances'],
        frequency: 'weekly',
      }),
    ).toEqual({
      answers: { rooms: 6 },
      options: [
        { code: 'windows', answers: {} },
        { code: 'appliances', answers: {} },
      ],
      frequency: 'weekly',
    });
    expect(
      convertLegacy(pest, { premisesType: 'apartment', quantity: 120, options: [], frequency: null }),
    ).toEqual({
      answers: { surface: 120, premises_type: 'housing' },
      options: [],
      frequency: null,
    });
    expect(
      convertLegacy(pest, { premisesType: 'other', quantity: 120, options: [], frequency: null })?.answers,
    ).toEqual({
      surface: 120,
    });
  });

  it('sans champ de taille d’équipe : pas de conversion possible', () => {
    const service = homeCleaningService();
    service.pricing.teamSize = { ...service.pricing.teamSize, fieldCode: null };
    expect(
      convertLegacy(service, { premisesType: 'house', quantity: 6, options: [], frequency: null }),
    ).toBeNull();
  });

  it('déduit les anciens champs des réponses', () => {
    expect(legacyQuantity(homeCleaningService(), { rooms: 6 })).toBe(6);
    expect(legacyQuantity(homeCleaningService(), {})).toBe(1);
    expect(legacyPremisesType({ premises_type: 'housing' })).toBe('house');
    expect(legacyPremisesType({ premises_type: 'shop' })).toBe('shop');
    expect(legacyPremisesType({})).toBe('other');
  });
});
