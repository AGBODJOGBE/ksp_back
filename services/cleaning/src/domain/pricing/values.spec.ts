import { type ParameterDefinition } from './types';
import { type SelectedType, selectionProblems, withAbsentBooleansAsNo } from './values';

const param = (code: string, patch: Partial<ParameterDefinition> = {}): ParameterDefinition => ({
  code,
  kind: 'number',
  min: null,
  max: null,
  choices: [],
  required: false,
  active: true,
  ...patch,
});

const place = [
  param('superficie', { min: 10, max: 5000, required: true }),
  param('chambres'),
  param('cour', { kind: 'boolean' }),
  param('salete', {
    kind: 'choice',
    choices: [
      { code: 'normal', active: true },
      { code: 'ancien', active: false },
    ],
  }),
  param('ancien_champ', { active: false }),
];
const sol: SelectedType = { cleaningTypeId: 'sol', packItemIds: [], extraParameters: [] };
const vitres: SelectedType = {
  cleaningTypeId: 'vitres',
  packItemIds: [],
  extraParameters: [param('fenetres', { required: true })],
};
const complet: SelectedType = {
  cleaningTypeId: 'complet',
  packItemIds: ['sol', 'vitres'],
  extraParameters: [],
};

const check = (selected: SelectedType[], values: Record<string, unknown>, acceptInactive = false) =>
  selectionProblems({ selected, placeParameters: place, values, acceptInactive });
const problem = (field: string, reason: string) => ({ field, reason });

describe('valeurs déclarées (R-PX-03)', () => {
  it('accepte des valeurs justes, bornes incluses', () => {
    expect(
      check([sol, vitres], { superficie: 10, chambres: 0, cour: true, salete: 'normal', fenetres: 12 }),
    ).toEqual([]);
    expect(check([sol], { superficie: 5000, chambres: 1_000_000 })).toEqual([]);
  });

  it('refuse une valeur hors des bornes du paramètre ou au-delà de 1 000 000', () => {
    expect(check([sol], { superficie: 9 })).toEqual([problem('values.superficie', 'out_of_range')]);
    expect(check([sol], { superficie: 5001 })).toEqual([problem('values.superficie', 'out_of_range')]);
    expect(check([sol], { superficie: 100, chambres: 1_000_001 })).toEqual([
      problem('values.chambres', 'out_of_range'),
    ]);
    expect(check([sol], { superficie: 100, chambres: -1 })).toEqual([
      problem('values.chambres', 'out_of_range'),
    ]);
  });

  it('refuse une valeur non entière ou d’une autre nature', () => {
    expect(check([sol], { superficie: 150.5 })).toEqual([problem('values.superficie', 'invalid_type')]);
    expect(check([sol], { superficie: '150' })).toEqual([problem('values.superficie', 'invalid_type')]);
    expect(check([sol], { superficie: 100, cour: 'oui' })).toEqual([problem('values.cour', 'invalid_type')]);
    expect(check([sol], { superficie: 100, salete: 1 })).toEqual([problem('values.salete', 'invalid_type')]);
  });

  it('exige les valeurs obligatoires du lieu et des offres choisies', () => {
    expect(check([sol, vitres], {})).toEqual([
      problem('values.superficie', 'required'),
      problem('values.fenetres', 'required'),
    ]);
  });
});

describe('valeur de choix (R-CA-06)', () => {
  it('refuse une valeur inconnue ou désactivée', () => {
    expect(check([sol], { superficie: 100, salete: 'boueux' })).toEqual([
      problem('values.salete', 'unknown_choice'),
    ]);
    expect(check([sol], { superficie: 100, salete: 'ancien' })).toEqual([
      problem('values.salete', 'unknown_choice'),
    ]);
  });

  it('accepte une valeur désactivée au simulateur de test du back-office (R-CA-08)', () => {
    expect(check([sol], { superficie: 100, salete: 'ancien' }, true)).toEqual([]);
  });
});

describe('choix envoyés (R-PX-09)', () => {
  it('refuse un type en double', () => {
    expect(check([sol, sol], { superficie: 100 })).toEqual([problem('cleaningTypeIds[1]', 'duplicate')]);
  });

  it('refuse un pack envoyé avec l’un de ses types, quel que soit l’ordre', () => {
    expect(check([complet, vitres], { superficie: 100, fenetres: 3 })).toEqual([
      problem('cleaningTypeIds[1]', 'pack_item_also_selected'),
    ]);
    expect(check([sol, complet], { superficie: 100 })).toEqual([
      problem('cleaningTypeIds[0]', 'pack_item_also_selected'),
    ]);
  });

  it('refuse une valeur qui n’appartient ni au lieu ni à une offre choisie', () => {
    expect(check([sol], { superficie: 100, fenetres: 3 })).toEqual([
      problem('values.fenetres', 'unknown_parameter'),
    ]);
  });

  it('refuse la valeur d’un paramètre désactivé, sauf au simulateur de test', () => {
    expect(check([sol], { superficie: 100, ancien_champ: 3 })).toEqual([
      problem('values.ancien_champ', 'unknown_parameter'),
    ]);
    expect(check([sol], { superficie: 100, ancien_champ: 3 }, true)).toEqual([]);
  });

  it('ne réclame pas un paramètre obligatoire désactivé', () => {
    const inactive = [param('superficie', { required: true, active: false })];
    expect(selectionProblems({ selected: [sol], placeParameters: inactive, values: {} })).toEqual([]);
  });

  it('un oui/non facultatif absent vaut « non »', () => {
    expect(withAbsentBooleansAsNo(place, { superficie: 100 })).toEqual({ superficie: 100, cour: false });
    expect(withAbsentBooleansAsNo(place, { superficie: 100, cour: true })).toEqual({
      superficie: 100,
      cour: true,
    });
  });
});
