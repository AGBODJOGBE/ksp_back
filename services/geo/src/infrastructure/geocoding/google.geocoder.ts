import { type ReverseGeocoder } from '../../application/ports';
import { addressCandidates, type GeocodedPlace } from '../../domain/geocoding';
import { type GeoPoint } from '../../domain/geo-point';
import { GeocodingFailure } from './geocoding';

export const GOOGLE_GEOCODING_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

export interface GoogleGeocoderOptions {
  /** Clé de l'API Geocoding (GOOGLE_MAPS_API_KEY), fournie par le coffre ; jamais journalisée. */
  apiKey: string;
  timeoutMs: number;
  /** Adresse de l'API, pour les tests ; par défaut celle de Google. */
  url?: string;
  fetch?: typeof fetch;
}

/**
 * Types de composant d'adresse, dans l'ordre d'essai : au Bénin, une commune est le plus souvent
 * `administrative_area_level_2` ; puis `locality`, l'arrondissement et le département.
 */
export const GOOGLE_COMPONENT_TYPES = [
  'administrative_area_level_2',
  'locality',
  'administrative_area_level_3',
  'administrative_area_level_1',
] as const;

interface GoogleComponent {
  long_name?: unknown;
  types?: unknown;
}

interface GoogleResult {
  formatted_address?: unknown;
  address_components?: GoogleComponent[];
}

/**
 * Géocodage inverse par Google Maps Geocoding (secours, payant). L'adresse appelée porte la clé
 * et la position : elle n'est jamais journalisée, ni tracée (hôte exclu des traces, ADR-034).
 */
export class GoogleGeocoder implements ReverseGeocoder {
  readonly name = 'google' as const;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: GoogleGeocoderOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async reverse(point: GeoPoint): Promise<GeocodedPlace | null> {
    const query = new URLSearchParams({
      latlng: `${point.latitude},${point.longitude}`,
      language: 'fr',
      key: this.options.apiKey,
    });
    let response: Response;
    try {
      response = await this.fetch(`${this.options.url ?? GOOGLE_GEOCODING_URL}?${query}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new GeocodingFailure(this.name, (error as Error).name || 'network');
    }
    if (!response.ok) throw new GeocodingFailure(this.name, `HTTP ${response.status}`);
    let body: { status?: unknown; results?: GoogleResult[] };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new GeocodingFailure(this.name, 'json');
    }
    if (body.status === 'ZERO_RESULTS') return null;
    // OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST… : la clé ou le quota sont en cause.
    if (body.status !== 'OK') throw new GeocodingFailure(this.name, `statut ${String(body.status)}`);
    const results = Array.isArray(body.results) ? body.results : [];
    const components = results.flatMap((result) => result.address_components ?? []);
    const communes = addressCandidates(
      GOOGLE_COMPONENT_TYPES.flatMap((type) =>
        components
          .filter((component) => Array.isArray(component.types) && component.types.includes(type))
          .map((component) => component.long_name),
      ),
    );
    if (!communes.length) return null;
    const formatted = results[0]?.formatted_address;
    return {
      provider: this.name,
      communes,
      displayAddress: typeof formatted === 'string' && formatted ? formatted : null,
    };
  }
}
