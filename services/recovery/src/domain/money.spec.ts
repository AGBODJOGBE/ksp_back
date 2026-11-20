import { ceilRate, floorRate, isRate, isWholeAmount } from './money';

describe('montants et taux en entiers', () => {
  it('arrondit au franc inférieur ou supérieur sans erreur de flottant', () => {
    expect(floorRate(1, 1_000)).toBe(0);
    expect(ceilRate(1, 1_000)).toBe(1);
    expect(floorRate(0, 10_000)).toBe(0);
    expect(ceilRate(0, 10_000)).toBe(0);
    expect(floorRate(32_040, 1_250)).toBe(4_005);
    expect(ceilRate(250_000, 1_000)).toBe(25_000);
    // Montant énorme : le calcul reste exact au franc près.
    expect(floorRate(900_000_000_001, 9_999)).toBe(899_910_000_000);
    expect(ceilRate(900_000_000_001, 9_999)).toBe(899_910_000_001);
  });

  it('refuse un calcul qui sortirait de la plage exacte', () => {
    expect(() => floorRate(Number.MAX_SAFE_INTEGER, 10_000)).toThrow(RangeError);
    expect(() => ceilRate(-1, 1_000)).toThrow(RangeError);
  });

  it('reconnaît montants et taux valides', () => {
    expect(isWholeAmount(0)).toBe(true);
    expect(isWholeAmount(1.5)).toBe(false);
    expect(isWholeAmount(-1)).toBe(false);
    expect(isRate(10_000)).toBe(true);
    expect(isRate(10_001)).toBe(false);
  });
});
