import { Logger } from '@nestjs/common';
import { type ReverseGeocoder } from '../../application/ports';
import { type GeocodedPlace, type GeoPoint } from '../../domain/location';
import { addressCandidates, GeocodingFailure } from './geocoding';

export interface NominatimOptions {
  /** Adresse du Nominatim auto-hébergé, sans barre finale (NOMINATIM_URL). */
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/**
 * Clés d'adresse de la réponse `jsonv2`, dans l'ordre d'essai : au Bénin, une commune est le plus
 * souvent `city`, `town` ou `county` ; `state` (département) en dernier recours.
 */
export const NOMINATIM_ADDRESS_KEYS = [
  'city',
  'town',
  'municipality',
  'county',
  'state_district',
  'state',
] as const;

/**
 * Géocodage inverse par un Nominatim auto-hébergé (GET /reverse?format=jsonv2). Ni l'adresse
 * appelée ni la réponse ne sont journalisées : elles portent la position du client.
 */
export class NominatimGeocoder implements ReverseGeocoder {
  readonly name = 'nominatim' as const;
  private readonly logger = new Logger('Nominatim');
  private readonly fetch: typeof fetch;

  constructor(private readonly options: NominatimOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async reverse(point: GeoPoint): Promise<GeocodedPlace | null> {
    const query = new URLSearchParams({
      format: 'jsonv2',
      lat: String(point.latitude),
      lon: String(point.longitude),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'fr',
    });
    let response: Response;
    try {
      response = await this.fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/reverse?${query}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'ksp-cleaning' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new GeocodingFailure(this.name, (error as Error).name || 'network');
    }
    if (!response.ok) throw new GeocodingFailure(this.name, `HTTP ${response.status}`);
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new GeocodingFailure(this.name, 'json');
    }
    // Point hors de toute adresse connue (mer, données absentes) : { "error": "Unable to geocode" }.
    if (typeof body['error'] === 'string') return null;
    const address = (body['address'] ?? {}) as Record<string, unknown>;
    const communes = addressCandidates(NOMINATIM_ADDRESS_KEYS.map((key) => address[key]));
    if (!communes.length) return null;
    const displayName = body['display_name'];
    this.logger.debug(`commune trouvée (${communes.length} nom(s))`);
    return {
      provider: this.name,
      communes,
      displayAddress: typeof displayName === 'string' && displayName ? displayName : null,
    };
  }
}
