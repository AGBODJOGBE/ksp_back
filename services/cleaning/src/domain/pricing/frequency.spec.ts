import { frequencyCoefficientFor, frequencyKeyOf } from './frequency';

describe('clé de fréquence (R-PX-06)', () => {
  it('hebdomadaire chaque semaine : weekly, y compris sans rythme précisé', () => {
    expect(frequencyKeyOf({ kind: 'weekly', everyWeeks: 1 })).toBe('weekly');
    expect(frequencyKeyOf({ kind: 'weekly', everyWeeks: null })).toBe('weekly');
  });

  it('toutes les N semaines, N de 2 à 12 : every_N_weeks', () => {
    expect(frequencyKeyOf({ kind: 'weekly', everyWeeks: 2 })).toBe('every_2_weeks');
    expect(frequencyKeyOf({ kind: 'weekly', everyWeeks: 12 })).toBe('every_12_weeks');
  });

  it('mensuel : monthly ; ponctuel ou sans programme : aucune clé', () => {
    expect(frequencyKeyOf({ kind: 'monthly', everyWeeks: null })).toBe('monthly');
    expect(frequencyKeyOf({ kind: 'one_off', everyWeeks: null })).toBeNull();
    expect(frequencyKeyOf(null)).toBeNull();
  });

  it('trouve le coefficient de la clé, ou rien sans entrée correspondante', () => {
    const coefficients = [
      { key: 'weekly', coefficientBps: 9000 },
      { key: 'monthly', coefficientBps: 9800 },
    ];
    expect(frequencyCoefficientFor(coefficients, 'weekly')).toBe(9000);
    expect(frequencyCoefficientFor(coefficients, 'every_2_weeks')).toBeNull();
    expect(frequencyCoefficientFor(coefficients, null)).toBeNull();
  });
});
