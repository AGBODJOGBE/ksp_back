import {
  type CommuneMatch,
  type GeocodedPlace,
  type GeoLocation,
  type GeoPoint,
  isValidAccuracy,
  isValidPoint,
  matchCommune,
  communeKey,
} from '../../domain/location';
import { findActiveZone } from '../../domain/zone';
import { type CleaningDeps } from '../deps';
import { currentCustomer } from '../shared/access';
import { CleaningErrors } from '../shared/errors';

/**
 * Position du lieu (ADR-034) : contrôle du point GPS et géocodage inverse, rapproché des zones
 * desservies. Les coordonnées ne sont jamais journalisées.
 */
export function parsePoint(input: { latitude: number; longitude: number }): GeoPoint {
  const point = { latitude: input.latitude, longitude: input.longitude };
  if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
    throw CleaningErrors.invalid('latitude', 'Latitude attendue entre -90 et 90.');
  }
  if (!isValidPoint(point))
    throw CleaningErrors.invalid('longitude', 'Longitude attendue entre -180 et 180.');
  return point;
}

/** Position d'une demande : point GPS et précision facultative (0 ou absente : inconnue). */
export function parseLocation(
  input: { latitude: number; longitude: number; accuracyMeters?: number | null | undefined } | undefined,
): GeoLocation {
  if (!input) throw CleaningErrors.invalid('location', 'Indiquez la position du lieu.');
  const point = parsePoint(input);
  const accuracyMeters = input.accuracyMeters ? input.accuracyMeters : null;
  if (!isValidAccuracy(accuracyMeters)) throw CleaningErrors.invalid('location.accuracyMeters');
  return { ...point, accuracyMeters };
}

export interface LocatedPoint {
  place: GeocodedPlace | null;
  match: CommuneMatch | null;
}

/** Géocodage inverse puis rapprochement des zones desservies ; une panne vaut « non trouvé ». */
export async function locate(deps: CleaningDeps, point: GeoPoint): Promise<LocatedPoint> {
  let place: GeocodedPlace | null = null;
  try {
    place = await deps.geocoder.reverse(point);
  } catch {
    place = null;
  }
  if (!place) return { place: null, match: null };
  return { place, match: matchCommune(place.communes, await deps.catalog.listZones()) };
}

export interface LocationResolution extends GeoPoint {
  commune: string | null;
  zoneCode: string | null;
  served: boolean;
  displayAddress: string | null;
  provider: GeocodedPlace['provider'] | null;
}

/**
 * Commune d'un point GPS, pour le client connecté (un des fournisseurs est payant). Aucun
 * fournisseur ne trouve : réponse vide, le client choisit sa commune dans la liste des zones.
 */
export class ResolveLocationUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { latitude: number; longitude: number }): Promise<LocationResolution> {
    currentCustomer();
    const point = parsePoint(input);
    const { place, match } = await locate(this.deps, point);
    return {
      ...point,
      commune: match?.commune ?? null,
      zoneCode: match?.zone?.code ?? null,
      served: Boolean(match?.zone),
      displayAddress: place?.displayAddress ?? null,
      provider: match && place ? place.provider : null,
    };
  }
}

/** Commune retenue : celle du géocodage, jamais celle du client quand il réussit (ADR-034). */
export interface ChosenCommune {
  commune: string;
  provider: GeocodedPlace['provider'] | null;
  displayAddress: string | null;
}

/**
 * Commune d'une position : celle trouvée par géocodage (la commune envoyée est alors ignorée),
 * refusée si elle n'est pas desservie ; sans résultat, celle choisie par le client, contrôlée de
 * même (demande groupée, correction de position).
 */
export async function chooseCommune(
  deps: CleaningDeps,
  location: GeoPoint,
  fallback: string | null,
): Promise<ChosenCommune> {
  const { place, match } = await locate(deps, location);
  if (place && match) {
    if (!match.zone) throw CleaningErrors.zoneNotCovered(match.commune);
    return { commune: match.zone.commune, provider: place.provider, displayAddress: place.displayAddress };
  }
  if (!fallback) throw CleaningErrors.locationUnresolved();
  const zone = findActiveZone(await deps.catalog.listZones(), communeKey(fallback));
  if (!zone) throw CleaningErrors.zoneNotCovered(fallback);
  return { commune: zone.commune, provider: null, displayAddress: place?.displayAddress ?? null };
}
