import { type ParameterLabels } from './offer-price';
import { type Tariff } from './types';

/**
 * Jeux d'essai des tests du calcul : tarifs « Maison × Sol » et « Maison × Vitres » de la partie 4
 * et de l'exemple de la partie 5 (montants fictifs du cahier des charges).
 */
export function solTariff(patch: Partial<Tariff> = {}): Tariff {
  return {
    version: 1,
    status: 'published',
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
  };
}

export function vitresTariff(patch: Partial<Tariff> = {}): Tariff {
  return {
    version: 2,
    status: 'published',
    baseParameterCode: 'fenetres',
    brackets: [{ from: 1, to: 20, mode: 'per_unit', amount: 500 }],
    supplements: [],
    minimum: 3000,
    frequencyCoefficients: [{ key: 'weekly', coefficientBps: 9000 }],
    packDiscountBps: null,
    ...patch,
  };
}

export const labels: ParameterLabels = {
  superficie: { label: 'superficie', unit: 'm²' },
  chambres: { label: 'chambres', unit: null },
  cour: { label: 'cour', unit: null },
  arriere_cour: { label: 'arrière-cour', unit: null },
  salete: { label: 'niveau de saleté', unit: null, choices: { apres_travaux: 'après travaux' } },
  fenetres: { label: 'fenêtres', unit: 'fenêtres' },
};

/** Villa de 120 m², 5 chambres, cour oui, arrière-cour non, 12 fenêtres (partie 5). */
export const villa = { superficie: 120, chambres: 5, cour: true, arriere_cour: false, fenetres: 12 };
