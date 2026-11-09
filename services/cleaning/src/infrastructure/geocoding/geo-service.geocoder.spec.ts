import { type geoV1 } from '@ksp/contracts';
import { AppError, GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable, of, throwError } from 'rxjs';
import { GeoServiceGeocoder } from './geo-service.geocoder';

const POINT = { latitude: 6.4489, longitude: 2.3556 };

function geocoder(answer: () => Observable<geoV1.ReverseGeocodeResponse>) {
  const requests: geoV1.ReverseGeocodeRequest[] = [];
  const client = {
    reverseGeocode: (request: geoV1.ReverseGeocodeRequest) => {
      requests.push(request);
      return answer();
    },
  } as unknown as geoV1.GeoServiceClient;
  return { requests, geocoder: new GeoServiceGeocoder(client, new GrpcCaller({ target: 'geo' }), 1_000) };
}

describe('géocodage inverse par le service geo', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    const record = (message: unknown) => {
      logs.push(String(message));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(record);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(record);
  });
  afterEach(() => jest.restoreAllMocks());

  it('rend les communes, l’adresse et le fournisseur de geo', async () => {
    const { geocoder: adapter, requests } = geocoder(() =>
      of({
        communes: ['Abomey-Calavi', 'Atlantique'],
        displayAddress: 'Zogbadjè, Abomey-Calavi, Bénin',
        provider: 'nominatim',
      }),
    );
    await expect(adapter.reverse(POINT)).resolves.toEqual({
      provider: 'nominatim',
      communes: ['Abomey-Calavi', 'Atlantique'],
      displayAddress: 'Zogbadjè, Abomey-Calavi, Bénin',
    });
    expect(requests).toEqual([{ point: POINT }]);
    expect(logs).toEqual(['geo (nominatim) : commune trouvée']);
  });

  it('aucune commune ou fournisseur inconnu : null ; adresse vide : null', async () => {
    await expect(
      geocoder(() => of({ communes: [], displayAddress: '', provider: '' })).geocoder.reverse(POINT),
    ).resolves.toBeNull();
    await expect(
      geocoder(() => of({ communes: ['Cotonou'], displayAddress: '', provider: 'autre' })).geocoder.reverse(
        POINT,
      ),
    ).resolves.toBeNull();
    await expect(
      geocoder(() => of({ communes: ['Cotonou'], displayAddress: '', provider: 'google' })).geocoder.reverse(
        POINT,
      ),
    ).resolves.toEqual({ provider: 'google', communes: ['Cotonou'], displayAddress: null });
  });

  it('geo indisponible : null, une seule tentative, journal sans coordonnées', async () => {
    const { geocoder: adapter, requests } = geocoder(() =>
      throwError(() => new AppError('UNAVAILABLE', 'GRPC_UNAVAILABLE', 'geo injoignable')),
    );
    await expect(adapter.reverse(POINT)).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(logs).toEqual(['geo : échec (GRPC_UNAVAILABLE)']);
    expect(logs.join(' ')).not.toMatch(/6\.44|2\.35/);
  });
});
