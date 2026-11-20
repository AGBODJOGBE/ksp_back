/**
 * Montants du Recouvrement : entiers de FCFA (XOF), jamais de décimales. Les taux sont en points de
 * base (10 000 = 100 %) ; un calcul garde la fraction exacte et n'arrondit qu'une fois, à la fin.
 */
export const CURRENCY = 'XOF';
export const BASIS_POINTS = 10_000;

/** Montant entier, positif ou nul, représentable sans perte. */
export function isWholeAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Taux en points de base, entier de 0 à 10 000. */
export function isRate(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= BASIS_POINTS;
}

/**
 * Produit montant × taux, exact en entiers. Au-delà de Number.MAX_SAFE_INTEGER le calcul perdrait des
 * francs : refusé plutôt qu'approché (un montant de 900 milliards de FCFA × 10 000 reste exact).
 */
export function rateProduct(amount: number, rateBp: number): number {
  const product = amount * rateBp;
  if (!Number.isSafeInteger(product) || product < 0) {
    throw new RangeError('Montant hors de la plage de calcul exact');
  }
  return product;
}

/** Quotient entier d'un produit en points de base, au franc inférieur, sans passer par un flottant. */
export function floorBasisPoints(product: number): number {
  return (product - (product % BASIS_POINTS)) / BASIS_POINTS;
}

/** Part d'un montant à un taux, arrondie au franc inférieur (KSP ne prélève jamais plus que le taux). */
export function floorRate(amount: number, rateBp: number): number {
  return floorBasisPoints(rateProduct(amount, rateBp));
}

/** Part d'un montant à un taux, arrondie au franc supérieur (un seuil minimum n'est jamais sous-estimé). */
export function ceilRate(amount: number, rateBp: number): number {
  const product = rateProduct(amount, rateBp);
  const floor = floorBasisPoints(product);
  return product % BASIS_POINTS === 0 ? floor : floor + 1;
}
