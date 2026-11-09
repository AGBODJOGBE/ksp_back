import { Logger } from '@nestjs/common';
import { type ReverseGeocoder } from '../../application/ports';
import { type GeocodedPlace, type GeocodingProvider } from '../../domain/geocoding';
import { type GeoPoint } from '../../domain/geo-point';
import { GeocodingFailure } from './geocoding';
import { GoogleGeocoder } from './google.geocoder';
import { NominatimGeocoder } from './nominatim.geocoder';

export interface NamedGeocoder extends ReverseGeocoder {
  readonly name: GeocodingProvider;
}

/**
 * Chaîne de fournisseurs (ADR-034, ADR-045) : le premier qui trouve une commune l'emporte ; une
 * panne, un délai dépassé ou une réponse vide font passer au suivant. Jamais d'erreur : null si
 * aucun ne trouve (l'appelant décide alors ; le Nettoyage fait choisir la commune au client).
 * Journal : fournisseur et résultat seulement, jamais les coordonnées.
 */
export class FallbackGeocoder implements ReverseGeocoder {
  private readonly logger = new Logger('Geocoding');

  constructor(private readonly providers: readonly NamedGeocoder[]) {}

  get providerNames(): GeocodingProvider[] {
    return this.providers.map((provider) => provider.name);
  }

  async reverse(point: GeoPoint): Promise<GeocodedPlace | null> {
    for (const provider of this.providers) {
      try {
        const place = await provider.reverse(point);
        if (place?.communes.length) {
          this.logger.log(`${provider.name} : commune trouvée`);
          return place;
        }
        this.logger.log(`${provider.name} : aucune commune`);
      } catch (error) {
        const reason = error instanceof GeocodingFailure ? error.reason : 'erreur';
        this.logger.warn(`${provider.name} : échec (${reason})`);
      }
    }
    return null;
  }
}

export interface GeocodingConfig {
  NOMINATIM_URL?: string | undefined;
  GOOGLE_MAPS_API_KEY?: string | undefined;
  GEOCODING_TIMEOUT_MS: number;
}

/** Nominatim auto-hébergé d'abord, Google en secours ; un fournisseur sans variable est désactivé. */
export function createGeocoder(config: GeocodingConfig, fetchImpl?: typeof fetch): FallbackGeocoder {
  const providers: NamedGeocoder[] = [];
  const common = { timeoutMs: config.GEOCODING_TIMEOUT_MS, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
  if (config.NOMINATIM_URL)
    providers.push(new NominatimGeocoder({ baseUrl: config.NOMINATIM_URL, ...common }));
  if (config.GOOGLE_MAPS_API_KEY)
    providers.push(new GoogleGeocoder({ apiKey: config.GOOGLE_MAPS_API_KEY, ...common }));
  return new FallbackGeocoder(providers);
}
