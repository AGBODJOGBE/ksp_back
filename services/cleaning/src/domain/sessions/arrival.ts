import { validationFailed } from './errors';

/**
 * Contrôle de position à l'arrivée d'une séance (partie 10, RV-44) : la position du chef d'équipe
 * est comparée à celle du lieu ; au-delà de `arrivalAlertMeters`, le superviseur est alerté, sans
 * blocage. La précision annoncée (0 ou absente : inconnue) aide à juger l'alerte, sans jamais la
 * supprimer.
 */
export interface GeoPoint {
  latitude: number;
  longitude: number;
  /** Précision annoncée par le téléphone ; 0 ou null : inconnue. */
  accuracyMeters?: number | null;
}

/** Valeurs du contrat ArrivalCheck (hors heure d'arrivée). */
export interface ArrivalGeoCheck {
  distanceMeters: number | null;
  alert: boolean;
  placeAccuracyMeters: number | null;
  arrivalAccuracyMeters: number | null;
  uncertain: boolean;
}

export const DEFAULT_ARRIVAL_ALERT_METERS = 300;
const MAX_ACCURACY_METERS = 100_000;
const EARTH_RADIUS_METERS = 6_371_000;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Distance à vol d'oiseau (haversine), arrondie au mètre. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h))));
}

function knownAccuracy(point: GeoPoint | null): number | null {
  const accuracy = point?.accuracyMeters ?? 0;
  return accuracy > 0 ? accuracy : null;
}

/**
 * Interprétation prudente de « l'alerte est marquée incertaine » : seule une alerte peut l'être, et
 * la somme ne compte que les précisions connues.
 */
export function isUncertainAlert(
  alert: boolean,
  accuracies: ReadonlyArray<number | null>,
  alertMeters: number,
) {
  const sum = accuracies.reduce<number>((total, accuracy) => total + (accuracy ?? 0), 0);
  return alert && sum > alertMeters;
}

export function arrivalCheck(input: {
  place: GeoPoint | null;
  position: GeoPoint | null;
  alertMeters: number;
}): ArrivalGeoCheck {
  const placeAccuracyMeters = knownAccuracy(input.place);
  const arrivalAccuracyMeters = knownAccuracy(input.position);
  const distance = input.place && input.position ? distanceMeters(input.place, input.position) : null;
  const alert = distance !== null && distance > input.alertMeters;
  return {
    distanceMeters: distance,
    alert,
    placeAccuracyMeters,
    arrivalAccuracyMeters,
    uncertain: isUncertainAlert(alert, [placeAccuracyMeters, arrivalAccuracyMeters], input.alertMeters),
  };
}

function inRange(field: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) throw validationFailed(field, 'out_of_range');
}

/**
 * Position envoyée par ArriveAtSession : latitude et longitude vont ensemble ; aucune des deux :
 * arrivée sans position (null).
 */
export function arrivalPosition(input: {
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
}): GeoPoint | null {
  const { latitude, longitude } = input;
  if (latitude == null && longitude == null) return null;
  if (latitude == null) throw validationFailed('latitude', 'required');
  if (longitude == null) throw validationFailed('longitude', 'required');
  inRange('latitude', latitude, -90, 90);
  inRange('longitude', longitude, -180, 180);
  if (input.accuracyMeters != null) inRange('accuracyMeters', input.accuracyMeters, 0, MAX_ACCURACY_METERS);
  return { latitude, longitude, accuracyMeters: input.accuracyMeters ?? null };
}
