/**
 * Montants du Nettoyage : entiers de FCFA (XOF), jamais de décimales (cahier des charges, partie 4).
 * Les coefficients sont en points de base : 10000 = coefficient 1.
 */
export const CURRENCY = 'XOF';
export const BASIS_POINTS = 10_000;

/** Montant entier, positif ou nul, représentable sans perte. */
export function isWholeAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Arrondi au multiple le plus proche (500 FCFA pour la fourchette du simulateur). */
export function roundToStep(amount: number, step: number): number {
  return Math.round(amount / step) * step;
}

/** Pourcentage d'un montant, arrondi au franc. */
export function percentOf(amount: number, percent: number): number {
  return Math.round((amount * percent) / 100);
}

/** Application d'un coefficient en points de base, arrondie au franc. */
export function applyCoefficient(amount: number, coefficientBp: number): number {
  return Math.round((amount * coefficientBp) / BASIS_POINTS);
}
