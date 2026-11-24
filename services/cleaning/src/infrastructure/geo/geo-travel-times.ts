import { type geoV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type TravelTime, travelFromMatrix } from '../../domain/planning/agenda';
import { type GeoPoint } from '../../application/ports';
import { type TravelTimes } from '../../application/planning/planning.ports';

/** Positions des lieux (déchiffrées) ; un lieu sans position connue est absent. */
export interface PlaceLocations {
  points(placeIds: readonly string[]): Promise<Map<string, GeoPoint>>;
}

/** Limite de DistanceMatrix : 25 origines et 25 destinations (geo.proto). */
const BLOCK = 25;

function blocks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += BLOCK) result.push(values.slice(start, start + BLOCK));
  return result;
}

/**
 * Temps de trajet en voiture entre lieux (R-ZN-02), calculés par geo (DistanceMatrix, OSRM), en
 * minutes entières arrondies au-dessus. Jamais d'erreur : geo indisponible, lieu sans position ou
 * trajet impossible laissent le couple absent, et le domaine applique la valeur par défaut des
 * réglages. Journal : code d'erreur seulement, jamais de position.
 */
export class GeoTravelTimes implements TravelTimes {
  private readonly logger = new Logger('TravelTimes');

  constructor(
    private readonly locations: PlaceLocations,
    private readonly client: geoV1.GeoServiceClient,
    private readonly caller: GrpcCaller,
    private readonly deadlineMs: number,
  ) {}

  async matrix(placeIds: readonly string[]): Promise<TravelTime> {
    const matrix: Record<string, Record<string, number>> = {};
    const unique = [...new Set(placeIds)];
    if (unique.length < 2) return travelFromMatrix(matrix);
    let points: Map<string, GeoPoint>;
    try {
      points = await this.locations.points(unique);
    } catch (error) {
      this.warn(error);
      return travelFromMatrix(matrix);
    }
    const located = unique.filter((id) => points.has(id));
    if (located.length < 2) return travelFromMatrix(matrix);
    for (const origins of blocks(located)) {
      for (const destinations of blocks(located)) {
        try {
          const response = await this.caller.call(
            'distanceMatrix',
            (metadata) =>
              this.client.distanceMatrix(
                {
                  origins: origins.map((id) => points.get(id)!),
                  destinations: destinations.map((id) => points.get(id)!),
                  profile: 'car',
                },
                metadata,
              ),
            { idempotent: true, retries: 0, deadlineMs: this.deadlineMs },
          );
          response.rows.forEach((row, i) =>
            row.cells.forEach((cell, j) => {
              if (!cell.reachable) return;
              (matrix[origins[i]!] ??= {})[destinations[j]!] = Math.ceil(cell.durationSeconds / 60);
            }),
          );
        } catch (error) {
          this.warn(error);
        }
      }
    }
    return travelFromMatrix(matrix);
  }

  private warn(error: unknown): void {
    const code = (error as { code?: unknown } | null)?.code;
    this.logger.warn(`geo : temps de trajet indisponibles (${typeof code === 'string' ? code : 'erreur'})`);
  }
}
