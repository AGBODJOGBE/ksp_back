import { type geoV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { of, throwError } from 'rxjs';
import { travelMinutes } from '../../domain/planning/agenda';
import { GeoTravelTimes, type PlaceLocations } from './geo-travel-times';

const POINTS: Record<string, { latitude: number; longitude: number }> = {
  a: { latitude: 6.36, longitude: 2.42 },
  b: { latitude: 6.49, longitude: 2.6 },
};
const locations: PlaceLocations = {
  points: async (ids) => new Map(ids.flatMap((id) => (POINTS[id] ? [[id, POINTS[id]!] as const] : []))),
};

function client(
  handler: (request: geoV1.DistanceMatrixRequest) => ReturnType<geoV1.GeoServiceClient['distanceMatrix']>,
) {
  const calls: geoV1.DistanceMatrixRequest[] = [];
  return {
    calls,
    client: {
      distanceMatrix: (request: geoV1.DistanceMatrixRequest) => {
        calls.push(request);
        return handler(request);
      },
    } as unknown as geoV1.GeoServiceClient,
  };
}

const cell = (seconds: number, reachable = true) => ({
  reachable,
  distanceMeters: 1000,
  durationSeconds: seconds,
});

describe('temps de trajet par geo (R-ZN-02)', () => {
  it('matrice des durées en minutes entières (arrondi supérieur), profil voiture', async () => {
    const fake = client((request) =>
      of({
        rows: request.origins.map((_, i) => ({
          cells: request.destinations.map((_, j) => (i === j ? cell(0) : cell(i === 0 ? 1_201 : 900))),
        })),
      }),
    );
    const travel = await new GeoTravelTimes(
      locations,
      fake.client,
      new GrpcCaller({ target: 'geo' }),
      2_000,
    ).matrix(['a', 'b', 'inconnu']);
    expect(travel('a', 'b')).toBe(21);
    expect(travel('b', 'a')).toBe(15);
    expect(travel('a', 'inconnu')).toBeNull();
    expect(travelMinutes('a', 'inconnu', travel, 30)).toBe(30);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.profile).toBe('car');
  });

  it('geo indisponible ou trajet impossible : aucun temps, la valeur par défaut s’applique', async () => {
    const down = client(() => throwError(() => AppError.unavailable('GEO_ROUTING_UNAVAILABLE', 'OSRM')));
    const travel = await new GeoTravelTimes(
      locations,
      down.client,
      new GrpcCaller({ target: 'geo' }),
      2_000,
    ).matrix(['a', 'b']);
    expect(travel('a', 'b')).toBeNull();
    expect(travelMinutes('a', 'b', travel, 30)).toBe(30);
    const unreachable = client(() =>
      of({ rows: [{ cells: [cell(0), cell(0, false)] }, { cells: [cell(0, false), cell(0)] }] }),
    );
    const none = await new GeoTravelTimes(
      locations,
      unreachable.client,
      new GrpcCaller({ target: 'geo' }),
      2_000,
    ).matrix(['a', 'b']);
    expect(none('a', 'b')).toBeNull();
  });

  it('un seul lieu connu : aucun appel', async () => {
    const fake = client(() => of({ rows: [] }));
    await new GeoTravelTimes(locations, fake.client, new GrpcCaller({ target: 'geo' }), 2_000).matrix([
      'a',
      'a',
    ]);
    expect(fake.calls).toEqual([]);
  });
});
