import { type GeoPoint, isValidLatitude, isValidLongitude } from '../domain/geo-point';
import { DEFAULT_TRAVEL_PROFILE, TRAVEL_PROFILES, type TravelProfile } from '../domain/routing';
import { GeoErrors } from './errors';

/** Point reçu (message gRPC facultatif) : présent et dans les bornes du globe. */
export function requirePoint(field: string, value: Partial<GeoPoint> | undefined): GeoPoint {
  if (!value) throw GeoErrors.invalid(field, 'La position est obligatoire.');
  const { latitude, longitude } = value;
  if (typeof latitude !== 'number' || !isValidLatitude(latitude)) {
    throw GeoErrors.invalid(`${field}.latitude`, 'La latitude doit être comprise entre -90 et 90.');
  }
  if (typeof longitude !== 'number' || !isValidLongitude(longitude)) {
    throw GeoErrors.invalid(`${field}.longitude`, 'La longitude doit être comprise entre -180 et 180.');
  }
  return { latitude, longitude };
}

/** Liste de points, de `min` à `max` éléments. */
export function requirePoints(
  field: string,
  values: readonly Partial<GeoPoint>[] | undefined,
  min: number,
  max: number,
): GeoPoint[] {
  const list = values ?? [];
  if (list.length < min || list.length > max) {
    throw GeoErrors.invalid(field, `Entre ${min} et ${max} positions sont attendues.`, { min, max });
  }
  return list.map((value, index) => requirePoint(`${field}[${index}]`, value));
}

/** Profil de déplacement : vide → « car ». */
export function requireProfile(value: string | undefined): TravelProfile {
  const profile = value?.trim() || DEFAULT_TRAVEL_PROFILE;
  if (!(TRAVEL_PROFILES as readonly string[]).includes(profile)) {
    throw GeoErrors.invalid('profile', 'Profil de déplacement inconnu.', { allowed: TRAVEL_PROFILES });
  }
  return profile as TravelProfile;
}
