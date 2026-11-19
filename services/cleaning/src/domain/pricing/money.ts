/**
 * Montants et coefficients du calcul du prix (partie 5, R-PX-02) : francs CFA entiers, coefficients
 * en points de base (10 000 = × 1, plafond × 10). Tout calcul est exact (BigInt), avec un seul
 * arrondi au franc le plus proche, moitié vers le haut.
 */
export const BASIS_POINTS = 10_000;
export const MAX_COEFFICIENT_BPS = 10 * BASIS_POINTS;
/** Montant saisi au back-office : entier de 0 à 100 000 000 (CleaningAmountInput). */
export const MAX_AMOUNT = 100_000_000;

/** Fourchette affichée (R-PX-07) : − 10 % / + 15 %, au multiple de 500 FCFA. */
const RANGE_LOW_PERCENT = 90n;
const RANGE_HIGH_PERCENT = 115n;
const RANGE_STEP = 500n;

export function isAmount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT;
}

export function isCoefficientBps(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_COEFFICIENT_BPS;
}

/** Quotient arrondi au plus proche, moitié vers le haut (numérateur et dénominateur positifs). */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Montant × produit des coefficients, arrondi une seule fois au franc. */
export function scaleByCoefficients(amount: number, coefficientsBps: readonly number[]): number {
  const bp = BigInt(BASIS_POINTS);
  let numerator = BigInt(amount);
  for (const coefficient of coefficientsBps) numerator *= BigInt(coefficient);
  return Number(roundHalfUp(numerator, bp ** BigInt(coefficientsBps.length)));
}

/** Part d'un montant en points de base (1000 = 10 %), arrondie au franc. */
export function percentOfBps(amount: number, bps: number): number {
  return Number(roundHalfUp(BigInt(amount) * BigInt(bps), BigInt(BASIS_POINTS)));
}

export interface PriceRange {
  low: number;
  high: number;
}

/** Fourchette d'un prix (R-PX-07) : prix × 0,90 arrondi au 500 inférieur, prix × 1,15 au 500 supérieur. */
export function priceRange(price: number): PriceRange {
  const value = BigInt(price);
  const lowDenominator = 100n * RANGE_STEP;
  const low = ((value * RANGE_LOW_PERCENT) / lowDenominator) * RANGE_STEP;
  const highNumerator = value * RANGE_HIGH_PERCENT;
  const high = ((highNumerator + lowDenominator - 1n) / lowDenominator) * RANGE_STEP;
  return { low: Number(low), high: Number(high) };
}
