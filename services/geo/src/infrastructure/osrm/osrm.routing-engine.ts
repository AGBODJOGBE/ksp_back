import { Logger } from '@nestjs/common';
import { GeoErrors } from '../../application/errors';
import { type RoutingEngine } from '../../application/ports';
import { type GeoPoint } from '../../domain/geo-point';
import { type Leg, type MatrixCell, type NearestRoad, type TravelProfile } from '../../domain/routing';

export interface OsrmOptions {
  /** Adresse d'osrm-routed (OSRM_URL) ; absente : routage indisponible, le reste du service sert. */
  baseUrl: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Profil OSRM de l'adresse appelée. osrm-routed sert un seul jeu de données : celui préparé (car). */
const OSRM_PROFILES: Record<TravelProfile, string> = { car: 'driving' };

interface OsrmBody {
  code?: unknown;
  message?: unknown;
  routes?: { distance?: unknown; duration?: unknown }[];
  distances?: (number | null)[][];
  durations?: (number | null)[][];
  waypoints?: { location?: unknown; distance?: unknown; name?: unknown }[];
}

/** Coordonnées OSRM : « longitude,latitude », séparées par des points-virgules. */
const coordinates = (points: readonly GeoPoint[]) =>
  points.map((point) => `${point.longitude},${point.latitude}`).join(';');

/** Mesure lue dans la réponse : un nombre fini et positif, arrondi ; null sinon. */
const whole = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => from + index).join(';');

/**
 * Moteur d'itinéraires OSRM (API HTTP v1 : /route, /table, /nearest), algorithme MLD. L'adresse
 * appelée porte les coordonnées : elle n'est jamais journalisée, et l'hôte d'OSRM_URL est exclu des
 * traces (ADR-045). OSRM absent, en panne, trop lent ou illisible : GEO_ROUTING_UNAVAILABLE. Une
 * réponse « Ok » sans distance ou durée lisible l'est aussi : jamais rendue 0 m ou 0 s (ADR-050).
 */
export class OsrmRoutingEngine implements RoutingEngine {
  private readonly logger = new Logger('Osrm');
  private readonly fetch: typeof fetch;

  constructor(private readonly options: OsrmOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async route(points: readonly GeoPoint[], profile: TravelProfile): Promise<Leg> {
    const body = await this.call('route', profile, points, (index) => `points[${index}]`, {
      overview: 'false',
      alternatives: 'false',
      steps: 'false',
    });
    const route = body.routes?.[0];
    if (!route) throw GeoErrors.routeNotFound();
    const distanceMeters = whole(route.distance);
    const durationSeconds = whole(route.duration);
    if (distanceMeters === null || durationSeconds === null) {
      return this.unavailable('route', 'réponse incomplète');
    }
    return { distanceMeters, durationSeconds };
  }

  async matrix(
    origins: readonly GeoPoint[],
    destinations: readonly GeoPoint[],
    profile: TravelProfile,
  ): Promise<MatrixCell[][]> {
    const field = (index: number) =>
      index < origins.length ? `origins[${index}]` : `destinations[${index - origins.length}]`;
    const body = await this.call('table', profile, [...origins, ...destinations], field, {
      sources: range(0, origins.length),
      destinations: range(origins.length, destinations.length),
      annotations: 'distance,duration',
    });
    // Une ligne par origine, une colonne par destination ; seule une cellule null est inaccessible.
    const complete = (table: unknown) =>
      Array.isArray(table) &&
      table.length === origins.length &&
      table.every((row) => Array.isArray(row) && row.length === destinations.length);
    if (!complete(body.distances) || !complete(body.durations)) {
      return this.unavailable('table', 'réponse incomplète');
    }
    const distances = body.distances as (number | null)[][];
    const durations = body.durations as (number | null)[][];
    const cells: MatrixCell[][] = [];
    for (const [row, distanceRow] of distances.entries()) {
      const line: MatrixCell[] = [];
      for (const [column, distance] of distanceRow.entries()) {
        const duration = durations[row]![column];
        if (distance === null || duration === null) {
          line.push(null);
          continue;
        }
        const distanceMeters = whole(distance);
        const durationSeconds = whole(duration);
        if (distanceMeters === null || durationSeconds === null) {
          return this.unavailable('table', 'réponse incomplète');
        }
        line.push({ distanceMeters, durationSeconds });
      }
      cells.push(line);
    }
    return cells;
  }

  async nearest(point: GeoPoint, profile: TravelProfile): Promise<NearestRoad> {
    const body = await this.call('nearest', profile, [point], () => 'point', { number: '1' });
    const waypoint = body.waypoints?.[0];
    const location = waypoint?.location;
    if (!Array.isArray(location) || typeof location[0] !== 'number' || typeof location[1] !== 'number') {
      throw GeoErrors.pointNotRoutable('point');
    }
    const distanceMeters = whole(waypoint?.distance);
    if (distanceMeters === null) return this.unavailable('nearest', 'réponse incomplète');
    return {
      point: { latitude: location[1], longitude: location[0] },
      distanceMeters,
      roadName: typeof waypoint?.name === 'string' ? waypoint.name : '',
    };
  }

  /** Appel d'un service OSRM ; `field` nomme le point fautif d'un NoSegment d'après son indice. */
  private async call(
    service: 'route' | 'table' | 'nearest',
    profile: TravelProfile,
    points: readonly GeoPoint[],
    field: (index: number) => string,
    query: Record<string, string>,
  ): Promise<OsrmBody> {
    if (!this.options.baseUrl) throw GeoErrors.routingUnavailable();
    const url =
      `${this.options.baseUrl.replace(/\/+$/, '')}/${service}/v1/${OSRM_PROFILES[profile]}/` +
      `${coordinates(points)}?${new URLSearchParams(query)}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      return this.unavailable(service, (error as Error).name || 'network');
    }
    let body: OsrmBody;
    try {
      body = (await response.json()) as OsrmBody;
    } catch {
      return this.unavailable(service, `HTTP ${response.status}, réponse illisible`);
    }
    // Les refus d'OSRM (400) portent leur code : NoRoute, NoSegment, InvalidQuery…
    if (body.code === 'Ok') return body;
    if (body.code === 'NoRoute') throw GeoErrors.routeNotFound();
    if (body.code === 'NoSegment') {
      // « Could not find a matching segment for coordinate 2 » : indice du point dans l'adresse.
      const index = /coordinate (\d+)/.exec(String(body.message))?.[1];
      throw GeoErrors.pointNotRoutable(field(Number(index ?? 0)));
    }
    return this.unavailable(service, `HTTP ${response.status}, code ${String(body.code)}`);
  }

  private unavailable(service: string, reason: string): never {
    this.logger.warn(`${service} : échec (${reason})`);
    throw GeoErrors.routingUnavailable();
  }
}
