import {
  categoryProblems,
  cleaningTypeProblems,
  holidayProblems,
  isCode,
  offerProblems,
  parameterNarrowing,
  parameterProblems,
  placeTypeProblems,
  skillProblems,
  zoneProblems,
} from './entries';

const number = {
  code: 'superficie',
  label: 'Superficie',
  kind: 'number' as const,
  unit: 'm²',
  min: 0,
  max: 5000,
  choices: [],
  help: null,
};
const choice = {
  code: 'salete',
  label: 'Niveau de saleté',
  kind: 'choice' as const,
  unit: null,
  min: null,
  max: null,
  choices: [
    { code: 'normal', label: 'Normal', active: true },
    { code: 'apres_travaux', label: 'Après travaux', active: false },
  ],
  help: null,
};

describe('éléments du catalogue (RV-27)', () => {
  it('codes stables : minuscule, chiffres et soulignés, 2 à 50 caractères', () => {
    expect(isCode('maison_2')).toBe(true);
    expect(isCode('M')).toBe(false);
    expect(isCode('2pieces')).toBe(false);
  });

  it('catégorie : nom obligatoire, ordre et frais de visite bornés', () => {
    expect(
      categoryProblems({ code: 'maison', name: 'Maison', icon: null, order: 0, visitFee: 5000 }),
    ).toEqual([]);
    expect(
      categoryProblems({ code: 'Maison', name: '', icon: 'x'.repeat(51), order: -1, visitFee: 100_000_001 }),
    ).toEqual([
      { field: 'code', reason: 'invalid_type' },
      { field: 'name', reason: 'required' },
      { field: 'icon', reason: 'out_of_range' },
      { field: 'order', reason: 'out_of_range' },
      { field: 'visitFee', reason: 'out_of_range' },
    ]);
  });

  it('compétence et jour férié', () => {
    expect(skillProblems({ code: 'vidange', name: 'Vidange' })).toEqual([]);
    expect(skillProblems({ code: 'vidange', name: 'x'.repeat(101) })).toEqual([
      { field: 'name', reason: 'out_of_range' },
    ]);
    expect(holidayProblems({ date: '2026-08-01', name: 'Fête nationale' })).toEqual([]);
    expect(holidayProblems({ date: '2027-02-30', name: '' })).toEqual([
      { field: 'date', reason: 'invalid_type' },
      { field: 'name', reason: 'required' },
    ]);
  });
});

describe('paramètre (R-CA-01, R-CA-06, R-CA-11)', () => {
  it('nombre : unité obligatoire, bornes de 0 à 1 000 000, min ≤ max', () => {
    expect(parameterProblems(number)).toEqual([]);
    expect(parameterProblems({ ...number, unit: null, min: 10, max: 5 })).toEqual([
      { field: 'unit', reason: 'required' },
      { field: 'max', reason: 'out_of_range' },
    ]);
    expect(parameterProblems({ ...number, min: -1, max: 1_000_001 })).toEqual([
      { field: 'min', reason: 'out_of_range' },
      { field: 'max', reason: 'out_of_range' },
    ]);
  });

  it('choix : une valeur active au moins, codes uniques ; unité et bornes refusées', () => {
    expect(parameterProblems(choice)).toEqual([]);
    expect(
      parameterProblems({
        ...choice,
        unit: 'm²',
        choices: [
          { code: 'normal', label: 'Normal', active: false },
          { code: 'normal', label: '', active: false },
          { code: 'X', label: 'X', active: false },
        ],
      }),
    ).toEqual([
      { field: 'unit', reason: 'not_applicable' },
      { field: 'choices', reason: 'required' },
      { field: 'choices[1].code', reason: 'duplicate' },
      { field: 'choices[1].label', reason: 'required' },
      { field: 'choices[2].code', reason: 'invalid_type' },
    ]);
    const many = Array.from({ length: 31 }, (_, index) => ({ code: `v${index}`, label: 'V', active: true }));
    expect(parameterProblems({ ...choice, choices: many })).toEqual([
      { field: 'choices', reason: 'out_of_range' },
    ]);
  });

  it('oui/non : ni bornes ni valeurs', () => {
    expect(
      parameterProblems({
        ...number,
        kind: 'boolean',
        unit: null,
        min: 0,
        max: null,
        choices: choice.choices,
      }),
    ).toEqual([
      { field: 'min', reason: 'not_applicable' },
      { field: 'choices', reason: 'not_applicable' },
    ]);
  });

  it('paramètre utilisé : bornes resserrées, valeur retirée, désactivation', () => {
    const before = { min: 0, max: 5000, choices: choice.choices, active: true };
    expect(parameterNarrowing(before, { ...before, min: null, max: null })).toEqual([]);
    expect(
      parameterNarrowing(before, {
        ...before,
        choices: [...choice.choices, { code: 'x', label: 'X', active: true }],
      }),
    ).toEqual([]);
    expect(parameterNarrowing(before, { min: 1, max: 4000, choices: [], active: false })).toEqual([
      'bounds_tightened',
      'choice_removed',
      'deactivated',
    ]);
    expect(parameterNarrowing({ ...before, min: null, max: null }, { ...before, max: 999_999 })).toEqual([
      'bounds_tightened',
    ]);
  });
});

describe('lieu (R-CA-01, R-CA-14)', () => {
  const area = { id: 'p1', kind: 'number' as const, active: true };
  const entry = {
    code: 'villa',
    name: 'Villa',
    icon: null,
    description: null,
    order: 0,
    isOther: false,
    parameters: [area, { id: 'p2', kind: 'boolean' as const, active: true }],
    areaParameterId: 'p1',
  };

  it('superficie : paramètre nombre actif du lieu', () => {
    expect(placeTypeProblems(entry)).toEqual([]);
    for (const areaParameterId of ['p2', 'p9']) {
      expect(placeTypeProblems({ ...entry, areaParameterId })).toEqual([
        { field: 'areaParameterId', reason: 'area_parameter_invalid' },
      ]);
    }
    expect(placeTypeProblems({ ...entry, parameters: [{ ...area, active: false }] })).toEqual([
      { field: 'areaParameterId', reason: 'area_parameter_invalid' },
    ]);
  });

  it('superficie obligatoire sauf pour un lieu « Autre » ; paramètres sans doublon', () => {
    expect(placeTypeProblems({ ...entry, areaParameterId: null })).toEqual([
      { field: 'areaParameterId', reason: 'required' },
    ]);
    expect(placeTypeProblems({ ...entry, isOther: true, parameters: [], areaParameterId: null })).toEqual([]);
    expect(placeTypeProblems({ ...entry, parameters: [area, area] })).toEqual([
      { field: 'parameterIds[1]', reason: 'duplicate' },
    ]);
    const many = Array.from({ length: 31 }, (_, index) => ({ ...area, id: `p${index}` }));
    expect(placeTypeProblems({ ...entry, parameters: many, areaParameterId: 'p0' })).toEqual([
      { field: 'parameterIds', reason: 'out_of_range' },
    ]);
  });
});

describe('type de nettoyage (R-CA-04, R-CA-09)', () => {
  const sol = {
    code: 'sol',
    name: 'Sol',
    description: null,
    icon: 'broom',
    isPack: false,
    requiredSkillCode: 'interieur',
    referenceDurationMinutes: 180,
    checklist: [{ code: 'sols_laves', label: 'Sols lavés', order: 0 }],
  };

  it('compétence exigée, sauf pour un pack qui n’en porte pas', () => {
    expect(cleaningTypeProblems(sol)).toEqual([]);
    expect(cleaningTypeProblems({ ...sol, requiredSkillCode: null })).toEqual([
      { field: 'requiredSkillCode', reason: 'required' },
    ]);
    expect(cleaningTypeProblems({ ...sol, requiredSkillCode: 'Intérieur' })).toEqual([
      { field: 'requiredSkillCode', reason: 'invalid_type' },
    ]);
    expect(cleaningTypeProblems({ ...sol, isPack: true, requiredSkillCode: null })).toEqual([]);
    expect(cleaningTypeProblems({ ...sol, isPack: true })).toEqual([
      { field: 'requiredSkillCode', reason: 'not_applicable' },
    ]);
  });

  it('durée de référence et liste de contrôle bornées, codes uniques', () => {
    expect(cleaningTypeProblems({ ...sol, referenceDurationMinutes: 1.5 })).toEqual([
      { field: 'referenceDurationMinutes', reason: 'invalid_type' },
    ]);
    expect(cleaningTypeProblems({ ...sol, referenceDurationMinutes: 1441 })).toEqual([
      { field: 'referenceDurationMinutes', reason: 'out_of_range' },
    ]);
    expect(
      cleaningTypeProblems({
        ...sol,
        checklist: [
          { code: 'a1', label: 'A', order: 0 },
          { code: 'a1', label: '', order: -1 },
          { code: 'A', label: 'B', order: 0 },
        ],
      }),
    ).toEqual([
      { field: 'checklist[1].code', reason: 'duplicate' },
      { field: 'checklist[1].label', reason: 'required' },
      { field: 'checklist[1].order', reason: 'out_of_range' },
      { field: 'checklist[2].code', reason: 'invalid_type' },
    ]);
    const many = Array.from({ length: 51 }, (_, index) => ({ code: `p${index}`, label: 'P', order: index }));
    expect(cleaningTypeProblems({ ...sol, checklist: many })).toEqual([
      { field: 'checklist', reason: 'out_of_range' },
    ]);
  });
});

describe('offre (R-CA-10, R-CA-13) et zone', () => {
  it('règle d’équipe contiguë, paramètres propres sans doublon', () => {
    const teamRule = [
      { fromArea: 0, toArea: 100, agents: 2, durationMinutes: 180 },
      { fromArea: 101, toArea: null, agents: 3, durationMinutes: 240 },
    ];
    expect(offerProblems({ extraParameterIds: ['p1'], teamRule, order: 0 })).toEqual([]);
    expect(
      offerProblems({
        extraParameterIds: ['p1', 'p1'],
        teamRule: [{ ...teamRule[1]!, fromArea: 5 }],
        order: 0,
      }),
    ).toEqual([
      { field: 'extraParameterIds[1]', reason: 'duplicate' },
      { field: 'teamRule[0]', reason: 'team_rule_gap' },
    ]);
  });

  it('zone : clé de commune, coefficient de 1 à 100 000, majoration et mode bornés', () => {
    const zone = {
      communeKey: 'abomey-calavi',
      name: 'Abomey-Calavi',
      coefficientBps: 10_000,
      visitFeeSurcharge: 1000,
      planningMode: null,
    };
    expect(zoneProblems(zone)).toEqual([]);
    expect(
      zoneProblems({
        communeKey: 'Cotonou',
        name: '',
        coefficientBps: 0,
        visitFeeSurcharge: -1,
        planningMode: 'auto',
      }),
    ).toEqual([
      { field: 'name', reason: 'required' },
      { field: 'visitFeeSurcharge', reason: 'out_of_range' },
      { field: 'communeKey', reason: 'invalid_type' },
      { field: 'coefficientBps', reason: 'out_of_range' },
      { field: 'planningMode', reason: 'invalid_type' },
    ]);
  });
});
