import { type GeocodedPlace } from '../domain/geocoding';
import { type GeoPoint } from '../domain/geo-point';
import { type Leg, type MatrixCell, type NearestRoad, type TravelProfile } from '../domain/routing';
import { type ReverseGeocoder, type RoutingEngine } from './ports';
import { createUseCases } from './use-cases';

const A = { latitude: 6.3654, longitude: 2.3912 };
const B = { latitude: 6.4489, longitude: 2.3556 };

/** Faux moteur : garde les appels reçus et rend une réponse fixe. */
class FakeRouting implements RoutingEngine {
  readonly calls: { method: string; points: GeoPoint[][]; profile: TravelProfile }[] = [];
  async route(points: readonly GeoPoint[], profile: TravelProfile): Promise<Leg> {
    this.calls.push({ method: 'route', points: [[...points]], profile });
    return { distanceMeters: 1000, durationSeconds: 120 };
  }
  async matrix(
    origins: readonly GeoPoint[],
    destinations: readonly GeoPoint[],
    profile: TravelProfile,
  ): Promise<MatrixCell[][]> {
    this.calls.push({ method: 'matrix', points: [[...origins], [...destinations]], profile });
    return origins.map(() => destinations.map(() => null));
  }
  async nearest(point: GeoPoint, profile: TravelProfile): Promise<NearestRoad> {
    this.calls.push({ method: 'nearest', points: [[point]], profile });
    return { point, distanceMeters: 0, roadName: '' };
  }
}

function setup(place: GeocodedPlace | null = null) {
  const routing = new FakeRouting();
  const geocoder: ReverseGeocoder = { reverse: async () => place };
  return { routing, useCases: createUseCases({ geocoder, routing }) };
}

const invalid = (field: string) => ({
  code: 'GEO_VALIDATION_FAILED',
  kind: 'INVALID_ARGUMENT',
  details: { field },
});

describe('ReverseGeocode', () => {
  it('rend le résultat du géocodeur ; position absente ou hors bornes refusée', async () => {
    const place = { provider: 'nominatim' as const, communes: ['Cotonou'], displayAddress: null };
    const { useCases } = setup(place);
    await expect(useCases.reverseGeocode.execute({ point: A })).resolves.toBe(place);
    await expect(useCases.reverseGeocode.execute({})).rejects.toMatchObject(invalid('point'));
    await expect(
      useCases.reverseGeocode.execute({ point: { latitude: 91, longitude: 2 } }),
    ).rejects.toMatchObject(invalid('point.latitude'));
    await expect(
      useCases.reverseGeocode.execute({ point: { latitude: 6, longitude: Number.NaN } }),
    ).rejects.toMatchObject(invalid('point.longitude'));
  });

  it('message d’erreur sans les coordonnées reçues', async () => {
    const { useCases } = setup();
    await expect(
      useCases.reverseGeocode.execute({ point: { latitude: 123.456, longitude: 2 } }),
    ).rejects.toThrow(/^La latitude doit être comprise entre -90 et 90\.$/);
  });
});

describe('Route, DistanceMatrix, Nearest', () => {
  it('profil vide : car ; points transmis dans l’ordre', async () => {
    const { useCases, routing } = setup();
    await expect(useCases.route.execute({ points: [A, B], profile: '' })).resolves.toEqual({
      distanceMeters: 1000,
      durationSeconds: 120,
    });
    await useCases.distanceMatrix.execute({ origins: [A], destinations: [B, A], profile: 'car' });
    await useCases.nearest.execute({ point: B });
    expect(routing.calls).toEqual([
      { method: 'route', points: [[A, B]], profile: 'car' },
      { method: 'matrix', points: [[A], [B, A]], profile: 'car' },
      { method: 'nearest', points: [[B]], profile: 'car' },
    ]);
  });

  it('profil inconnu, nombre de points ou point invalide : refus avant tout appel', async () => {
    const { useCases, routing } = setup();
    await expect(useCases.route.execute({ points: [A, B], profile: 'motorbike' })).rejects.toMatchObject({
      details: { field: 'profile', allowed: ['car'] },
    });
    await expect(useCases.route.execute({ points: [A] })).rejects.toMatchObject({
      details: { field: 'points', min: 2, max: 25 },
    });
    await expect(
      useCases.route.execute({ points: Array.from({ length: 26 }, () => A) }),
    ).rejects.toMatchObject(invalid('points'));
    await expect(
      useCases.route.execute({ points: [A, { latitude: 6, longitude: 200 }] }),
    ).rejects.toMatchObject(invalid('points[1].longitude'));
    await expect(useCases.distanceMatrix.execute({ origins: [A], destinations: [] })).rejects.toMatchObject(
      invalid('destinations'),
    );
    await expect(
      useCases.distanceMatrix.execute({ origins: [{ latitude: -95, longitude: 0 }], destinations: [B] }),
    ).rejects.toMatchObject(invalid('origins[0].latitude'));
    await expect(useCases.nearest.execute({ point: undefined })).rejects.toMatchObject(invalid('point'));
    expect(routing.calls).toEqual([]);
  });
});
