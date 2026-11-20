import { type geoV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable, of, throwError } from 'rxjs';
import { COMMUNES_CACHE_MS, GeoServiceCommuneDirectory } from './geo-service.communes';

const COMMUNES = [
  { key: 'cotonou', name: 'Cotonou', department: 'Littoral' },
  { key: 'abomey-calavi', name: 'Abomey-Calavi', department: 'Atlantique' },
];

function directory(answer: () => Observable<geoV1.ListCommunesResponse>) {
  let calls = 0;
  let clock = 0;
  const client = {
    listCommunes: () => {
      calls += 1;
      return answer();
    },
  } as unknown as geoV1.GeoServiceClient;
  const adapter = new GeoServiceCommuneDirectory(client, new GrpcCaller({ target: 'geo' }), () => clock);
  return { adapter, calls: () => calls, advance: (ms: number) => (clock += ms) };
}

describe('référentiel des communes de geo (R-ZN-03, RV-35)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('rend clés et noms officiels, gardés 5 minutes', async () => {
    const geo = directory(() => of({ communes: COMMUNES, boundariesVersion: 'v1' }));
    await expect(geo.adapter.listCommunes()).resolves.toEqual([
      { key: 'cotonou', name: 'Cotonou' },
      { key: 'abomey-calavi', name: 'Abomey-Calavi' },
    ]);
    await geo.adapter.listCommunes();
    expect(geo.calls()).toBe(1);
    geo.advance(COMMUNES_CACHE_MS + 1);
    await geo.adapter.listCommunes();
    expect(geo.calls()).toBe(2);
  });

  it('geo indisponible : CLEANING_GEO_UNAVAILABLE, jamais de liste inventée', async () => {
    const geo = directory(() => throwError(() => AppError.unavailable('GEO_UNAVAILABLE', 'panne')));
    await expect(geo.adapter.listCommunes()).rejects.toMatchObject({ code: 'CLEANING_GEO_UNAVAILABLE' });
  });
});
