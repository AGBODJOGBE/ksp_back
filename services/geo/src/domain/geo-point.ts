/**
 * Point GPS en degrés décimaux (WGS 84). Les coordonnées d'un client, d'une boutique ou d'un
 * livreur sont des données personnelles : jamais dans les journaux ni dans les traces (ADR-045).
 */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** Bornes du globe ; le Bénin est attendu, mais un point hors du pays n'est pas refusé. */
export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
