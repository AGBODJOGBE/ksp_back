import { normalizeCommune } from './catalog';
import { findActiveZone, type Zone } from './zone';

/**
 * Position du lieu d'intervention (ADR-034) : un point GPS donné par le téléphone du client et un
 * point de repère en texte. La commune est retrouvée par géocodage inverse, puis rapprochée des
 * zones desservies avec la même normalisation que `Zone.code`. Les coordonnées sont des données
 * personnelles : jamais dans les journaux ni dans les événements.
 */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeoLocation extends GeoPoint {
  /** Précision annoncée par le téléphone, en mètres ; null si inconnue. */
  accuracyMeters: number | null;
}

export const GEOCODING_PROVIDERS = ['nominatim', 'google'] as const;
export type GeocodingProvider = (typeof GEOCODING_PROVIDERS)[number];

/** Précision la plus large acceptée (100 km) : au-delà, la position n'a pas de sens. */
export const MAX_ACCURACY_METERS = 100_000;

export function isValidPoint(point: GeoPoint): boolean {
  const { latitude, longitude } = point;
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function isValidAccuracy(accuracyMeters: number | null): boolean {
  return (
    accuracyMeters === null ||
    (Number.isFinite(accuracyMeters) && accuracyMeters >= 0 && accuracyMeters <= MAX_ACCURACY_METERS)
  );
}

/** Réponse d'un fournisseur de géocodage inverse. */
export interface GeocodedPlace {
  provider: GeocodingProvider;
  /** Noms de commune possibles, du plus probable au moins probable (déjà dédoublonnés). */
  communes: string[];
  displayAddress: string | null;
}

/** Préfixes administratifs retirés avant la comparaison (« Commune d'Abomey-Calavi »). */
const ADMINISTRATIVE_PREFIX =
  /^(commune|municipalite|municipality)\s+(de\s+la\s+|de\s+l'|de\s+|du\s+|des\s+|d')?/;

/** Clé d'un nom de commune rendu par un fournisseur : même normalisation que `Zone.code`. */
export function communeKey(name: string): string {
  const plain = name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[’`]/g, "'");
  return normalizeCommune(plain.replace(ADMINISTRATIVE_PREFIX, ''));
}

export interface CommuneMatch {
  /** Nom de la zone desservie, ou le premier nom trouvé par le fournisseur. */
  commune: string;
  /** Zone desservie active correspondante, null si la commune n'est pas desservie. */
  zone: Zone | null;
}

/**
 * Rapproche les communes proposées des zones desservies : la première qui correspond à une zone
 * active l'emporte ; sinon la première trouvée, non desservie. Null sans aucun nom.
 */
export function matchCommune(candidates: readonly string[], zones: readonly Zone[]): CommuneMatch | null {
  const names = candidates.map((name) => name.trim()).filter(Boolean);
  if (!names.length) return null;
  for (const name of names) {
    const zone = findActiveZone(zones, communeKey(name));
    if (zone) return { commune: zone.commune, zone };
  }
  return { commune: names[0]!, zone: null };
}

/**
 * Conservation de la position (ADR-035) : date avant laquelle une demande ou une mission clôturée
 * perd ses coordonnées, sa précision, son repère et son adresse géocodée (N mois civils, en UTC ; le
 * jour est ramené au dernier jour du mois si besoin).
 */
export function locationRetentionCutoff(now: Date, months: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/** Lieu d'une demande ou d'une mission : ce qui se masque et s'efface (ADR-035). */
export interface PlaceDetails {
  address: string;
  location: GeoLocation | null;
  landmark: string | null;
}

/**
 * Lieu sans position ni repère : l'adresse est vidée quand elle n'est que le repère (parcours par
 * lieu, ADR-034), sinon gardée.
 */
export function withoutPosition<T extends PlaceDetails>(place: T): T {
  return {
    ...place,
    address: place.landmark !== null && place.address === place.landmark ? '' : place.address,
    location: null,
    landmark: null,
  };
}
