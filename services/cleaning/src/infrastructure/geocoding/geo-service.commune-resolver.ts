import { type geoV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type CommuneResolver, type ResolvedCommune } from '../../application/requests/requests.ports';
import { CleaningErrors } from '../../application/shared/errors';

/**
 * Commune dont le contour contient un point (geo.ResolveCommune, R-ZN-01, ADR-059, RV-47) : une
 * nouvelle tentative, puis CLEANING_GEO_UNAVAILABLE. Un point hors de tout contour n'est pas une
 * erreur (commune absente). Le journal ne porte que l'opération et le code d'erreur, jamais le point.
 */
export class GeoServiceCommuneResolver implements CommuneResolver {
  private readonly logger = new Logger('CommuneResolver');

  constructor(
    private readonly client: geoV1.GeoServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async resolve(point: { latitude: number; longitude: number }): Promise<ResolvedCommune> {
    let response: geoV1.ResolveCommuneResponse;
    try {
      response = await this.caller.call(
        'resolveCommune',
        (metadata) => this.client.resolveCommune({ point }, metadata),
        { idempotent: true },
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.logger.warn(`geo : commune non déterminée (${typeof code === 'string' ? code : 'erreur'})`);
      throw CleaningErrors.geoUnavailable();
    }
    return {
      commune: response.commune ? { key: response.commune.key, name: response.commune.name } : null,
      boundariesVersion: response.boundariesVersion || null,
    };
  }
}
