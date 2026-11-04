import {
  definitionProblems,
  isFullyPriced,
  legacyUnit,
  recommendedTeamSize,
  type ServiceDefinition,
  type ServiceDraft,
} from './catalog';
import { gardenService, homeCleaningService, numberField } from './testing';

const draft = (service: ServiceDefinition = homeCleaningService()): ServiceDraft => ({
  name: service.name,
  description: service.description,
  active: service.active,
  fields: service.fields,
  options: service.options,
  pricing: {
    minimumPrice: service.pricing.minimumPrice,
    communeCoefficients: service.pricing.communeCoefficients,
    defaultCoefficientBp: service.pricing.defaultCoefficientBp,
    frequencies: service.pricing.frequencies,
    teamSize: service.pricing.teamSize,
    checklist: service.pricing.checklist,
  },
});

describe('définition d’une prestation', () => {
  it('accepte les prestations d’exemple', () => {
    expect(definitionProblems(draft())).toEqual([]);
    expect(definitionProblems(draft(gardenService()))).toEqual([]);
  });

  it('exige au moins un champ actif', () => {
    const value = draft();
    value.fields = value.fields.map((field) => ({ ...field, active: false }));
    expect(definitionProblems(value)).toContain('fields');
  });

  it('refuse codes en double, bornes incohérentes, unité absente, montants non entiers', () => {
    const value = draft();
    value.fields = [
      numberField('rooms', 'Pièces', 'pièces', 12.5, { min: 5, max: 2 }),
      numberField('rooms', 'Doublon', '', null),
      { ...value.fields[0]!, choices: [] },
    ];
    expect(definitionProblems(value)).toEqual([
      'fields[0].max',
      'fields[0].pricePerUnit',
      'fields[1].code',
      'fields[1].unitLabel',
      'fields[2].choices',
    ]);
  });

  it('contrôle valeurs, options, fréquences et taille d’équipe', () => {
    const value = draft();
    value.fields = value.fields.map((field) =>
      field.code === 'condition'
        ? { ...field, choices: field.choices.map((choice) => ({ ...choice, coefficientBp: 0 })) }
        : field,
    );
    value.options = [...value.options, { ...value.options[0]!, flatPrice: -1 }];
    value.pricing = {
      ...value.pricing,
      frequencies: [{ code: 'once', label: '', coefficientBp: 10_000, active: true }],
      teamSize: { fieldCode: 'condition', unitsPerAgent: 3, minAgents: 4, maxAgents: 2 },
    };
    expect(definitionProblems(value)).toEqual([
      'fields[3].choices[0].coefficientBp',
      'fields[3].choices[1].coefficientBp',
      'fields[3].choices[2].coefficientBp',
      'options[3].code',
      'options[3].flatPrice',
      'pricing.frequencies[0].label',
      'pricing.teamSize',
      'pricing.teamSize.fieldCode',
    ]);
  });
});

describe('prestation chiffrable et unité de l’ancien formulaire', () => {
  it('chiffrable quand tous les prix nécessaires des champs actifs sont fixés', () => {
    expect(isFullyPriced(homeCleaningService())).toBe(true);
    const service = homeCleaningService();
    service.fields[4] = { ...service.fields[4]!, coefficientBpIfYes: null };
    expect(isFullyPriced(service)).toBe(false);
  });

  it('déduit l’unité de l’ancien formulaire du champ de la taille d’équipe', () => {
    expect(legacyUnit(homeCleaningService())).toBe('room');
    expect(legacyUnit(gardenService())).toBe('square_meter');
    const septic = gardenService();
    septic.fields = [numberField('tank_volume', 'Volume de la fosse', 'm³', null)];
    septic.pricing = {
      ...septic.pricing,
      teamSize: { ...septic.pricing.teamSize, fieldCode: 'tank_volume' },
    };
    expect(legacyUnit(septic)).toBe('cubic_meter');
  });

  it('taille d’équipe dans les bornes, ou celle demandée', () => {
    const rule = { fieldCode: null, unitsPerAgent: 3, minAgents: 1, maxAgents: 6 };
    expect(recommendedTeamSize(rule, 1)).toBe(1);
    expect(recommendedTeamSize(rule, 7)).toBe(3);
    expect(recommendedTeamSize(rule, 100)).toBe(6);
    expect(recommendedTeamSize(rule, 7, 50)).toBe(6);
  });
});
