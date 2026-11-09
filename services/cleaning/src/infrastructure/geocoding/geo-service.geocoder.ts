import { type geoV1 } from '@ksp/contracts';
import { type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type ReverseGeocoder } from '../../application/ports';
import {
  type GeocodedPlace,
  GEOCODING_PROVIDERS,
  type GeocodingProvider,
  type GeoPoint,
} from '../../domain/location';

const isProvider = (value: string): value is GeocodingProvider =>
  (GEOCODING_PROVIDERS as readonly string[]).includes(value);

/**
 * Géocodage inverse par le service interne geo (ADR-045), qui porte la chaîne Nominatim puis
 * Google d'ADR-034. Appel gRPC avec le jeton de service de cleaning, délai du GrpcCaller, sans
 * nouvelle tentative : geo enchaîne déjà ses fournisseurs avec leurs propres délais. Comme le
 * port l'exige, jamais d'erreur : geo indisponible ou réponse vide valent « non trouvé » (le client
 * choisit alors sa commune). Journal : code d'erreur seulement, jamais les coordonnées.
 */
export class GeoServiceGeocoder implements ReverseGeocoder {
  private readonly logger = new Logger('Geocoding');

  constructor(
    private readonly client: geoV1.GeoServiceClient,
    private readonly caller: GrpcCaller,
    private readonly deadlineMs: number,
  ) {}

  async reverse(point: GeoPoint): Promise<GeocodedPlace | null> {
    let response: geoV1.ReverseGeocodeResponse;
    try {
      response = await this.caller.call(
        'reverseGeocode',
        (metadata) =>
          this.client.reverseGeocode(
            { point: { latitude: point.latitude, longitude: point.longitude } },
            metadata,
          ),
        { idempotent: true, retries: 0, deadlineMs: this.deadlineMs },
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.logger.warn(`geo : échec (${typeof code === 'string' ? code : 'erreur'})`);
      return null;
    }
    if (!response.communes.length || !isProvider(response.provider)) {
      this.logger.log('geo : aucune commune');
      return null;
    }
    this.logger.log(`geo (${response.provider}) : commune trouvée`);
    return {
      provider: response.provider,
      communes: response.communes,
      displayAddress: response.displayAddress || null,
    };
  }
}
