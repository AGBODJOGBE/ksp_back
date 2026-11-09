import { addressCandidates } from './geocoding';
import { isValidLatitude, isValidLongitude } from './geo-point';

describe('point GPS', () => {
  it('accepte les bornes du globe, refuse le reste', () => {
    expect(isValidLatitude(6.37)).toBe(true);
    expect(isValidLatitude(-90)).toBe(true);
    expect(isValidLatitude(90.0001)).toBe(false);
    expect(isValidLatitude(Number.NaN)).toBe(false);
    expect(isValidLongitude(2.39)).toBe(true);
    expect(isValidLongitude(180)).toBe(true);
    expect(isValidLongitude(-180.5)).toBe(false);
    expect(isValidLongitude(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('noms de commune candidats', () => {
  it('garde les noms non vides, sans doublon, dans l’ordre', () => {
    expect(addressCandidates([' Cotonou ', undefined, 'Littoral', 'Cotonou', 3, ''])).toEqual([
      'Cotonou',
      'Littoral',
    ]);
  });
});
