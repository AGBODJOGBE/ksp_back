import { type FieldCipher, type GeoPoint } from '../ports';
import { cleaningErrors } from '../shared/errors';
import { text } from '../shared/input';
import { caseErrors } from './case-errors';
import { type EncryptedLocation, type ResolvedCommune } from './requests.ports';

/**
 * Positions du lieu et du dossier (R-DM-01, R-DM-08, RV-44, RV-45). Données personnelles : chiffrées
 * en base (FieldCipher, contexte `<objet>:<id>:<champ>`), jamais journalisées ni publiées.
 * La position est écrite sous la forme {"latitude","longitude"} (lue par le calcul des trajets du
 * lot D), avec la précision annoncée `accuracyM` quand elle est connue.
 */
export interface PlainLocation {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  landmark: string | null;
  address: string | null;
  readableAddress: string | null;
}

export type LocationScope = 'place' | 'request';

const context = (scope: LocationScope, id: string, field: string) => `${scope}:${id}:${field}`;

/** Précision annoncée par le téléphone : 0 ou absente = inconnue ; bornée (RV-44). */
export const MAX_ACCURACY_METERS = 100_000;

/**
 * RV-45 : coordonnées finies, dans leurs bornes, latitude et longitude ensemble. Absentes toutes les
 * deux : null (rien de changé).
 */
export function parsePoint(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): GeoPoint | null {
  const hasLat = latitude !== undefined && latitude !== null;
  const hasLng = longitude !== undefined && longitude !== null;
  if (!hasLat && !hasLng) return null;
  if (!hasLat) throw cleaningErrors.invalid('latitude', 'required');
  if (!hasLng) throw cleaningErrors.invalid('longitude', 'required');
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)
    throw cleaningErrors.invalid('latitude', 'out_of_range');
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)
    throw cleaningErrors.invalid('longitude', 'out_of_range');
  return { latitude, longitude };
}

export function parseAccuracy(value: number | null | undefined): number | null {
  if (value === undefined || value === null || value === 0) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_ACCURACY_METERS)
    throw cleaningErrors.invalid('accuracyMeters', 'out_of_range');
  return value;
}

/** Texte saisi facultatif (repère, adresse), 500 caractères au plus, espaces retirés. */
export const optionalText = (value: string | null | undefined, field: string) => text(value, field);

const seal = (cipher: FieldCipher, value: string | null, ctx: string) =>
  value === null ? null : cipher.encrypt(value, ctx);

function open(cipher: FieldCipher, value: string | null, ctx: string): string | null {
  if (value === null) return null;
  try {
    return cipher.decrypt(value, ctx);
  } catch {
    // Chiffré illisible (autre clé) : traité comme absent.
    return null;
  }
}

export function encryptLocation(
  cipher: FieldCipher,
  scope: LocationScope,
  id: string,
  location: PlainLocation,
  resolved: ResolvedCommune & { commune: { key: string } },
): EncryptedLocation {
  const gps = JSON.stringify({
    latitude: location.latitude,
    longitude: location.longitude,
    ...(location.accuracyM !== null ? { accuracyM: location.accuracyM } : {}),
  });
  return {
    gpsEncrypted: cipher.encrypt(gps, context(scope, id, 'gps')),
    landmarkEncrypted: seal(cipher, location.landmark, context(scope, id, 'landmark')),
    addressEncrypted: seal(cipher, location.address, context(scope, id, 'address')),
    readableAddressEncrypted: seal(cipher, location.readableAddress, context(scope, id, 'readable_address')),
    communeKey: resolved.commune.key,
    communeBoundariesVersion: resolved.boundariesVersion,
    locationErasedAt: null,
  };
}

/** Position en clair ; null si elle a été effacée (R-DP-01) ou est illisible. */
export function decryptLocation(
  cipher: FieldCipher,
  scope: LocationScope,
  id: string,
  stored: EncryptedLocation,
): PlainLocation | null {
  const gps = open(cipher, stored.gpsEncrypted, context(scope, id, 'gps'));
  if (gps === null || stored.locationErasedAt) return null;
  const point = JSON.parse(gps) as { latitude: number; longitude: number; accuracyM?: number };
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    accuracyM: point.accuracyM ?? null,
    landmark: open(cipher, stored.landmarkEncrypted, context(scope, id, 'landmark')),
    address: open(cipher, stored.addressEncrypted, context(scope, id, 'address')),
    readableAddress: open(cipher, stored.readableAddressEncrypted, context(scope, id, 'readable_address')),
  };
}

/** Commune retrouvée par contour, sinon CLEANING_ZONE_NOT_COVERED (`outside_boundaries`). */
export function requireCommune(resolved: ResolvedCommune): ResolvedCommune & {
  commune: { key: string; name: string };
} {
  if (!resolved.commune) throw caseErrors.zoneNotCovered('outside_boundaries', null);
  return resolved as ResolvedCommune & { commune: { key: string; name: string } };
}

/** Distance en mètres entre deux points (haversine), pour l'alerte à l'arrivée (partie 10). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
}
