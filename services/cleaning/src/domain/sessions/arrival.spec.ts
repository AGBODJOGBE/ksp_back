import { arrivalCheck, arrivalPosition, distanceMeters } from './arrival';

/** Lieu à Porto-Novo ; un millième de degré de latitude vaut 111,19 m. */
const PLACE = { latitude: 6.4969, longitude: 2.6289, accuracyMeters: 20 };
const north = (degrees: number, accuracyMeters: number | null = 10) => ({
  latitude: PLACE.latitude + degrees,
  longitude: PLACE.longitude,
  accuracyMeters,
});

describe('distance au lieu', () => {
  it('même point : 0 m ; 0,0027° de latitude : 300 m', () => {
    expect(distanceMeters(PLACE, PLACE)).toBe(0);
    expect(distanceMeters(PLACE, north(0.0027))).toBe(300);
  });
});

describe('alerte à l’arrivée (partie 10, RV-44)', () => {
  it('300 m pile : pas d’alerte ; 301 m : alerte au superviseur, sans blocage', () => {
    expect(arrivalCheck({ place: PLACE, position: north(0.0027), alertMeters: 300 })).toEqual({
      distanceMeters: 300,
      alert: false,
      placeAccuracyMeters: 20,
      arrivalAccuracyMeters: 10,
      uncertain: false,
    });
    expect(arrivalCheck({ place: PLACE, position: north(0.002707), alertMeters: 300 })).toMatchObject({
      distanceMeters: 301,
      alert: true,
      uncertain: false,
    });
  });

  it('alerte « incertaine » quand la somme des précisions dépasse le seuil ; jamais supprimée', () => {
    const far = north(0.01, 281);
    expect(arrivalCheck({ place: PLACE, position: far, alertMeters: 300 })).toMatchObject({
      alert: true,
      uncertain: true,
    });
    expect(arrivalCheck({ place: PLACE, position: north(0.01, 280), alertMeters: 300 })).toMatchObject({
      alert: true,
      uncertain: false,
    });
  });

  it('sans alerte, des précisions larges ne marquent rien', () => {
    expect(arrivalCheck({ place: PLACE, position: north(0, 5000), alertMeters: 300 })).toMatchObject({
      alert: false,
      uncertain: false,
    });
  });

  it('arrivée sans position, ou lieu sans position : distance nulle, pas d’alerte', () => {
    const empty = {
      distanceMeters: null,
      alert: false,
      placeAccuracyMeters: null,
      arrivalAccuracyMeters: null,
      uncertain: false,
    };
    expect(arrivalCheck({ place: PLACE, position: null, alertMeters: 300 })).toEqual({
      ...empty,
      placeAccuracyMeters: 20,
    });
    expect(arrivalCheck({ place: null, position: north(0.1), alertMeters: 300 })).toEqual({
      ...empty,
      arrivalAccuracyMeters: 10,
    });
  });

  it('précision 0 ou absente : inconnue, comptée pour rien', () => {
    const check = arrivalCheck({
      place: { ...PLACE, accuracyMeters: 0 },
      position: north(0.01, null),
      alertMeters: 300,
    });
    expect(check).toMatchObject({ placeAccuracyMeters: null, arrivalAccuracyMeters: null, uncertain: false });
  });
});

describe('position envoyée par l’application', () => {
  it('latitude et longitude vont ensemble ; aucune des deux : arrivée sans position', () => {
    expect(arrivalPosition({})).toBeNull();
    expect(arrivalPosition({ latitude: 6.5, longitude: 2.6, accuracyMeters: 12 })).toEqual({
      latitude: 6.5,
      longitude: 2.6,
      accuracyMeters: 12,
    });
    expect(() => arrivalPosition({ latitude: 6.5 })).toThrow(
      expect.objectContaining({ details: { field: 'longitude', reason: 'required' } }),
    );
    expect(() => arrivalPosition({ longitude: 2.6 })).toThrow(
      expect.objectContaining({ details: { field: 'latitude', reason: 'required' } }),
    );
  });

  it('bornes incluses : ±90, ±180, précision de 0 à 100 000 m', () => {
    expect(arrivalPosition({ latitude: -90, longitude: 180, accuracyMeters: 100_000 })).not.toBeNull();
    expect(() => arrivalPosition({ latitude: 90.0001, longitude: 0 })).toThrow(
      expect.objectContaining({ details: { field: 'latitude', reason: 'out_of_range' } }),
    );
    expect(() => arrivalPosition({ latitude: 0, longitude: -180.0001 })).toThrow(
      expect.objectContaining({ details: { field: 'longitude', reason: 'out_of_range' } }),
    );
    expect(() => arrivalPosition({ latitude: 0, longitude: 0, accuracyMeters: 100_001 })).toThrow(
      expect.objectContaining({ details: { field: 'accuracyMeters', reason: 'out_of_range' } }),
    );
    expect(() => arrivalPosition({ latitude: 0, longitude: 0, accuracyMeters: -1 })).toThrow();
  });
});
