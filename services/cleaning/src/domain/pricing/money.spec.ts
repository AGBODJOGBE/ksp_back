import {
  BASIS_POINTS,
  MAX_AMOUNT,
  MAX_COEFFICIENT_BPS,
  isAmount,
  isCoefficientBps,
  percentOfBps,
  priceRange,
  scaleByCoefficients,
} from './money';

describe('montants et coefficients (R-PX-02)', () => {
  it('reconnaît un montant entier de 0 à 100 000 000', () => {
    expect(isAmount(0)).toBe(true);
    expect(isAmount(MAX_AMOUNT)).toBe(true);
    expect(isAmount(MAX_AMOUNT + 1)).toBe(false);
    expect(isAmount(-1)).toBe(false);
    expect(isAmount(10.5)).toBe(false);
  });

  it('reconnaît un coefficient de 1 à 100 000 points de base (plafond × 10)', () => {
    expect(isCoefficientBps(1)).toBe(true);
    expect(isCoefficientBps(MAX_COEFFICIENT_BPS)).toBe(true);
    expect(isCoefficientBps(0)).toBe(false);
    expect(isCoefficientBps(MAX_COEFFICIENT_BPS + 1)).toBe(false);
    expect(isCoefficientBps(9000.5)).toBe(false);
  });

  it('applique des coefficients en calcul exact, arrondi une seule fois, moitié vers le haut', () => {
    expect(scaleByCoefficients(29_600, [9000])).toBe(26_640);
    expect(scaleByCoefficients(1, [15_000])).toBe(2);
    expect(scaleByCoefficients(1, [14_999])).toBe(1);
    // 333 × 1,1 × 1,1 = 402,93 : un seul arrondi, pas deux.
    expect(scaleByCoefficients(333, [11_000, 11_000])).toBe(403);
    expect(scaleByCoefficients(12_345, [])).toBe(12_345);
    expect(scaleByCoefficients(0, [MAX_COEFFICIENT_BPS])).toBe(0);
  });

  it('reste exact pour de grands montants', () => {
    expect(scaleByCoefficients(MAX_AMOUNT, [MAX_COEFFICIENT_BPS, MAX_COEFFICIENT_BPS])).toBe(
      MAX_AMOUNT * 100,
    );
    expect(scaleByCoefficients(999_999_999, [BASIS_POINTS + 1])).toBe(1_000_099_999);
  });

  it('calcule un pourcentage en points de base, arrondi au franc, moitié vers le haut', () => {
    expect(percentOfBps(10_001, 1000)).toBe(1000);
    expect(percentOfBps(10_005, 1000)).toBe(1001);
    expect(percentOfBps(10_000, 0)).toBe(0);
  });
});

describe('fourchette affichée (R-PX-07)', () => {
  it('borne basse au multiple de 500 inférieur, borne haute au multiple de 500 supérieur', () => {
    expect(priceRange(32_040)).toEqual({ low: 28_500, high: 37_000 });
  });

  it('garde un multiple exact de 500', () => {
    // 10 000 × 0,9 = 9 000 et 10 000 × 1,15 = 11 500 tombent juste.
    expect(priceRange(10_000)).toEqual({ low: 9000, high: 11_500 });
    expect(priceRange(0)).toEqual({ low: 0, high: 0 });
  });

  it('arrondit vers le haut dès le premier franc au-delà', () => {
    expect(priceRange(1)).toEqual({ low: 0, high: 500 });
  });
});
