import { type ReverseGeocoder } from '../../application/ports';
import { type GeocodedPlace } from '../../domain/geocoding';
import { type GeoPoint } from '../../domain/geo-point';

export interface GeocodingCacheOptions {
  /** Durée de vie d'un résultat, en millisecondes (0 : cache désactivé). */
  ttlMs: number;
  /** Nombre maximal de résultats gardés ; au-delà, le moins récemment lu est oublié. */
  maxEntries: number;
  now?: () => number;
}

/**
 * Cache en mémoire, borné, des résultats trouvés : la même position est géocodée deux fois dans un
 * parcours (affichage de la commune, puis envoi de la demande), et Google est payant. Clé : la
 * position arrondie au millionième de degré (environ 10 cm). Un échec ou une absence de résultat
 * n'est pas gardé (un fournisseur revenu doit pouvoir répondre). Les positions ne vivent qu'en
 * mémoire, le temps de la durée de vie : jamais écrites ni journalisées.
 */
export class CachedGeocoder implements ReverseGeocoder {
  private readonly entries = new Map<string, { place: GeocodedPlace; expiresAt: number }>();
  private readonly now: () => number;

  constructor(
    private readonly inner: ReverseGeocoder,
    private readonly options: GeocodingCacheOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  async reverse(point: GeoPoint): Promise<GeocodedPlace | null> {
    if (this.options.ttlMs <= 0 || this.options.maxEntries <= 0) return this.inner.reverse(point);
    const key = `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
    const cached = this.entries.get(key);
    this.entries.delete(key);
    if (cached && cached.expiresAt > this.now()) {
      this.entries.set(key, cached); // Remis en dernier : le plus récemment lu.
      return cached.place;
    }
    const place = await this.inner.reverse(point);
    if (place) {
      this.entries.set(key, { place, expiresAt: this.now() + this.options.ttlMs });
      while (this.entries.size > this.options.maxEntries) {
        this.entries.delete(this.entries.keys().next().value as string);
      }
    }
    return place;
  }
}
