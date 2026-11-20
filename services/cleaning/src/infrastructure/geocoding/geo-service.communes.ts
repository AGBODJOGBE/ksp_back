import { type geoV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Commune, type CommuneDirectory } from '../../application/catalog/catalog.ports';
import { CleaningErrors } from '../../application/shared/errors';

/** Durée du cache court du référentiel (RV-35) : 5 minutes. */
export const COMMUNES_CACHE_MS = 5 * 60_000;

/**
 * Référentiel des communes du service geo (ListCommunes, R-ZN-03), gardé 5 minutes : les 77
 * communes du Bénin changent rarement. geo indisponible et rien en cache : CLEANING_GEO_UNAVAILABLE,
 * jamais de réponse inventée.
 */
export class GeoServiceCommuneDirectory implements CommuneDirectory {
  private readonly logger = new Logger('Communes');
  private cache: { communes: Commune[]; until: number } | null = null;

  constructor(
    private readonly client: geoV1.GeoServiceClient,
    private readonly caller: GrpcCaller,
    private readonly now: () => number = Date.now,
  ) {}

  async listCommunes(): Promise<Commune[]> {
    if (this.cache && this.cache.until > this.now()) return this.cache.communes;
    let response: geoV1.ListCommunesResponse;
    try {
      response = await this.caller.call(
        'listCommunes',
        (metadata) => this.client.listCommunes({}, metadata),
        {
          idempotent: true,
        },
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.logger.warn(
        `geo : référentiel des communes indisponible (${typeof code === 'string' ? code : 'erreur'})`,
      );
      throw CleaningErrors.geoUnavailable();
    }
    const communes = response.communes.map((commune) => ({ key: commune.key, name: commune.name }));
    this.cache = { communes, until: this.now() + COMMUNES_CACHE_MS };
    return communes;
  }
}
