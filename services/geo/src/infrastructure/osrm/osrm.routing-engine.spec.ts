import { Logger } from '@nestjs/common';
import { OsrmRoutingEngine } from './osrm.routing-engine';

const CADJEHOUN = { latitude: 6.3654, longitude: 2.3912 };
const CALAVI = { latitude: 6.4489, longitude: 2.3556 };
const PORTO_NOVO = { latitude: 6.4969, longitude: 2.6283 };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Faux OSRM : réponses en file, adresses appelées gardées. */
function fakeOsrm(...responses: (Response | Error)[]) {
  const urls: URL[] = [];
  const impl = (async (url: string | URL | Request) => {
    urls.push(new URL(String(url)));
    const next = responses.shift();
    if (!next) throw new Error('aucune réponse prévue');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return {
    engine: new OsrmRoutingEngine({ baseUrl: 'http://osrm:5000/', timeoutMs: 50, fetch: impl }),
    urls,
  };
}

describe('OSRM : itinéraire, matrice, point le plus proche', () => {
  it('route : coordonnées longitude,latitude ; distance et durée arrondies', async () => {
    const { engine, urls } = fakeOsrm(
      json({ code: 'Ok', routes: [{ distance: 14_211.6, duration: 1_342.4 }], waypoints: [] }),
    );
    await expect(engine.route([CADJEHOUN, CALAVI], 'car')).resolves.toEqual({
      distanceMeters: 14_212,
      durationSeconds: 1_342,
    });
    expect(urls[0]!.pathname).toBe('/route/v1/driving/2.3912,6.3654;2.3556,6.4489');
    expect(urls[0]!.searchParams.get('overview')).toBe('false');
  });

  it('matrice : origines puis destinations, cellule inaccessible à null', async () => {
    const { engine, urls } = fakeOsrm(
      json({
        code: 'Ok',
        distances: [
          [14_211.6, 30_120],
          [null, 25_000.2],
        ],
        durations: [
          [1_342.4, 2_400],
          [null, 1_900.7],
        ],
      }),
    );
    await expect(engine.matrix([CADJEHOUN, CALAVI], [CALAVI, PORTO_NOVO], 'car')).resolves.toEqual([
      [
        { distanceMeters: 14_212, durationSeconds: 1_342 },
        { distanceMeters: 30_120, durationSeconds: 2_400 },
      ],
      [null, { distanceMeters: 25_000, durationSeconds: 1_901 }],
    ]);
    expect(urls[0]!.pathname).toMatch(/^\/table\/v1\/driving\/[^/]+;[^/]+;[^/]+;[^/]+$/);
    expect(urls[0]!.searchParams.get('sources')).toBe('0;1');
    expect(urls[0]!.searchParams.get('destinations')).toBe('2;3');
    expect(urls[0]!.searchParams.get('annotations')).toBe('distance,duration');
  });

  it('point le plus proche : position remise en latitude, longitude', async () => {
    const { engine } = fakeOsrm(
      json({ code: 'Ok', waypoints: [{ location: [2.39131, 6.36552], distance: 12.7, name: 'Rue 12.150' }] }),
    );
    await expect(engine.nearest(CADJEHOUN, 'car')).resolves.toEqual({
      point: { latitude: 6.36552, longitude: 2.39131 },
      distanceMeters: 13,
      roadName: 'Rue 12.150',
    });
  });

  it('aucun itinéraire, point hors du réseau : erreurs non réessayables, point désigné', async () => {
    await expect(
      fakeOsrm(json({ code: 'NoRoute', message: 'Impossible route' }, 400)).engine.route(
        [CADJEHOUN, CALAVI],
        'car',
      ),
    ).rejects.toMatchObject({ code: 'GEO_ROUTE_NOT_FOUND', kind: 'NOT_FOUND' });
    const noSegment = (index: number) =>
      json({ code: 'NoSegment', message: `Could not find a matching segment for coordinate ${index}` }, 400);
    await expect(fakeOsrm(noSegment(1)).engine.route([CADJEHOUN, CALAVI], 'car')).rejects.toMatchObject({
      code: 'GEO_POINT_NOT_ROUTABLE',
      details: { field: 'points[1]' },
    });
    await expect(
      fakeOsrm(noSegment(2)).engine.matrix([CADJEHOUN, CALAVI], [PORTO_NOVO], 'car'),
    ).rejects.toMatchObject({ details: { field: 'destinations[0]' } });
    await expect(fakeOsrm(noSegment(0)).engine.nearest(CADJEHOUN, 'car')).rejects.toMatchObject({
      details: { field: 'point' },
    });
  });

  describe('OSRM indisponible : GEO_ROUTING_UNAVAILABLE, journal sans coordonnées', () => {
    let logs: string[];
    beforeEach(() => {
      logs = [];
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
        logs.push(String(message));
      });
    });
    afterEach(() => jest.restoreAllMocks());

    const unavailable = { code: 'GEO_ROUTING_UNAVAILABLE', kind: 'UNAVAILABLE' };

    it('sans OSRM_URL : aucun appel', async () => {
      const engine = new OsrmRoutingEngine({
        baseUrl: undefined,
        timeoutMs: 50,
        fetch: () => Promise.reject(new Error('ne doit pas être appelé')),
      });
      await expect(engine.route([CADJEHOUN, CALAVI], 'car')).rejects.toMatchObject(unavailable);
    });

    it('réseau, délai dépassé, réponse illisible ou code inattendu', async () => {
      const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason as Error));
        })) as typeof fetch;
      const timedOut = new OsrmRoutingEngine({ baseUrl: 'http://osrm:5000', timeoutMs: 20, fetch: slow });
      await expect(timedOut.nearest(CADJEHOUN, 'car')).rejects.toMatchObject(unavailable);
      await expect(
        fakeOsrm(new TypeError('fetch failed')).engine.route([CADJEHOUN, CALAVI], 'car'),
      ).rejects.toMatchObject(unavailable);
      await expect(
        fakeOsrm(new Response('<html>Bad Gateway</html>', { status: 502 })).engine.route(
          [CADJEHOUN, CALAVI],
          'car',
        ),
      ).rejects.toMatchObject(unavailable);
      await expect(
        fakeOsrm(json({ code: 'TooBig' }, 400)).engine.matrix([CADJEHOUN], [CALAVI], 'car'),
      ).rejects.toMatchObject(unavailable);
      expect(logs).toHaveLength(4);
      expect(logs[0]).toMatch(/^nearest : échec \((TimeoutError|AbortError)\)$/);
      expect(logs.join(' ')).not.toMatch(/6\.36|2\.39|6\.44|2\.35/);
    });
  });
});
