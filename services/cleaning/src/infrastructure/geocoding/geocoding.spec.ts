import { Logger } from '@nestjs/common';
import { createGeocoder, FallbackGeocoder, type NamedGeocoder } from './fallback.geocoder';
import { GeocodingFailure } from './geocoding';
import { GOOGLE_GEOCODING_URL, GoogleGeocoder } from './google.geocoder';
import { NominatimGeocoder } from './nominatim.geocoder';

const POINT = { latitude: 6.4489, longitude: 2.3556 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** fetch simulé : réponses en file, adresses appelées gardées. */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('aucune réponse prévue');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const NOMINATIM_CALAVI = {
  place_id: 1,
  display_name: 'Zogbadjè, Abomey-Calavi, Atlantique, Bénin',
  address: {
    suburb: 'Zogbadjè',
    town: 'Abomey-Calavi',
    county: 'Abomey-Calavi',
    state: 'Atlantique',
    country: 'Bénin',
    country_code: 'bj',
  },
};

const GOOGLE_COTONOU = {
  status: 'OK',
  results: [
    {
      formatted_address: 'Rue 12.150, Cotonou, Bénin',
      address_components: [
        { long_name: 'Rue 12.150', types: ['route'] },
        { long_name: 'Cotonou', types: ['locality', 'political'] },
        { long_name: 'Cotonou', types: ['administrative_area_level_2', 'political'] },
        { long_name: 'Littoral', types: ['administrative_area_level_1', 'political'] },
        { long_name: 'Bénin', types: ['country', 'political'] },
      ],
    },
  ],
};

describe('géocodage inverse : Nominatim (jsonv2)', () => {
  it('lit city, town, county… dans l’ordre, sans doublon, avec l’adresse lisible', async () => {
    const { impl, calls } = fakeFetch(json(NOMINATIM_CALAVI));
    const geocoder = new NominatimGeocoder({
      baseUrl: 'http://nominatim:8080/',
      timeoutMs: 3000,
      fetch: impl,
    });
    await expect(geocoder.reverse(POINT)).resolves.toEqual({
      provider: 'nominatim',
      communes: ['Abomey-Calavi', 'Atlantique'],
      displayAddress: 'Zogbadjè, Abomey-Calavi, Atlantique, Bénin',
    });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('http://nominatim:8080/reverse');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('lat')).toBe('6.4489');
    expect(url.searchParams.get('lon')).toBe('2.3556');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('point sans adresse : null ; panne ou réponse illisible : échec du fournisseur', async () => {
    const empty = fakeFetch(json({ error: 'Unable to geocode' }));
    await expect(
      new NominatimGeocoder({ baseUrl: 'http://n', timeoutMs: 10, fetch: empty.impl }).reverse(POINT),
    ).resolves.toBeNull();
    const noCommune = fakeFetch(json({ address: { country: 'Bénin' } }));
    await expect(
      new NominatimGeocoder({ baseUrl: 'http://n', timeoutMs: 10, fetch: noCommune.impl }).reverse(POINT),
    ).resolves.toBeNull();
    const down = fakeFetch(json({}, 503));
    await expect(
      new NominatimGeocoder({ baseUrl: 'http://n', timeoutMs: 10, fetch: down.impl }).reverse(POINT),
    ).rejects.toBeInstanceOf(GeocodingFailure);
    const garbled = fakeFetch(new Response('<html>', { status: 200 }));
    await expect(
      new NominatimGeocoder({ baseUrl: 'http://n', timeoutMs: 10, fetch: garbled.impl }).reverse(POINT),
    ).rejects.toMatchObject({ reason: 'json' });
  });
});

describe('géocodage inverse : Google (address_components)', () => {
  it('administrative_area_level_2 d’abord, puis locality, puis le département', async () => {
    const { impl, calls } = fakeFetch(json(GOOGLE_COTONOU));
    const geocoder = new GoogleGeocoder({ apiKey: 'cle-test', timeoutMs: 3000, fetch: impl });
    await expect(geocoder.reverse(POINT)).resolves.toEqual({
      provider: 'google',
      communes: ['Cotonou', 'Littoral'],
      displayAddress: 'Rue 12.150, Cotonou, Bénin',
    });
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_GEOCODING_URL);
    expect(url.searchParams.get('latlng')).toBe('6.4489,2.3556');
    expect(url.searchParams.get('key')).toBe('cle-test');
  });

  it('ZERO_RESULTS : null ; clé refusée ou quota : échec du fournisseur', async () => {
    const none = fakeFetch(json({ status: 'ZERO_RESULTS', results: [] }));
    await expect(
      new GoogleGeocoder({ apiKey: 'k', timeoutMs: 10, fetch: none.impl }).reverse(POINT),
    ).resolves.toBeNull();
    const denied = fakeFetch(json({ status: 'REQUEST_DENIED', results: [] }));
    await expect(
      new GoogleGeocoder({ apiKey: 'k', timeoutMs: 10, fetch: denied.impl }).reverse(POINT),
    ).rejects.toMatchObject({ provider: 'google', reason: 'statut REQUEST_DENIED' });
  });
});

describe('géocodage inverse : chaîne de repli', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const provider = (name: 'nominatim' | 'google', reverse: NamedGeocoder['reverse']): NamedGeocoder => ({
    name,
    reverse,
  });

  it('Nominatim en panne : Google répond ; journal sans coordonnées', async () => {
    const chain = new FallbackGeocoder([
      provider('nominatim', async () => {
        throw new GeocodingFailure('nominatim', 'TimeoutError');
      }),
      provider('google', async () => ({ provider: 'google', communes: ['Cotonou'], displayAddress: null })),
    ]);
    await expect(chain.reverse(POINT)).resolves.toMatchObject({ provider: 'google', communes: ['Cotonou'] });
    expect(logs).toEqual(['nominatim : échec (TimeoutError)', 'google : commune trouvée']);
    expect(logs.join(' ')).not.toMatch(/6\.44|2\.35/);
  });

  it('aucun fournisseur ne trouve : null, jamais d’erreur ; chaîne vide : null', async () => {
    const chain = new FallbackGeocoder([
      provider('nominatim', async () => null),
      provider('google', async () => ({ provider: 'google', communes: [], displayAddress: null })),
    ]);
    await expect(chain.reverse(POINT)).resolves.toBeNull();
    await expect(new FallbackGeocoder([]).reverse(POINT)).resolves.toBeNull();
  });

  it('délai dépassé : l’appel est interrompu et le fournisseur suivant prend le relais', async () => {
    const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
      })) as typeof fetch;
    const nominatim = new NominatimGeocoder({ baseUrl: 'http://n', timeoutMs: 20, fetch: slow });
    const google = new GoogleGeocoder({
      apiKey: 'k',
      timeoutMs: 20,
      fetch: fakeFetch(json(GOOGLE_COTONOU)).impl,
    });
    const started = Date.now();
    await expect(new FallbackGeocoder([nominatim, google]).reverse(POINT)).resolves.toMatchObject({
      provider: 'google',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(logs[0]).toMatch(/^nominatim : échec \((TimeoutError|AbortError)\)$/);
  });

  it('fournisseurs activés par leur variable : Nominatim puis Google, ou aucun', () => {
    expect(
      createGeocoder({ NOMINATIM_URL: 'http://n', GOOGLE_MAPS_API_KEY: 'k', GEOCODING_TIMEOUT_MS: 3000 })
        .providerNames,
    ).toEqual(['nominatim', 'google']);
    expect(createGeocoder({ GOOGLE_MAPS_API_KEY: 'k', GEOCODING_TIMEOUT_MS: 3000 }).providerNames).toEqual([
      'google',
    ]);
    expect(createGeocoder({ GEOCODING_TIMEOUT_MS: 3000 }).providerNames).toEqual([]);
  });
});
