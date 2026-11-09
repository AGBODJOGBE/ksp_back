import { type GeoPoint } from './geo-point';

/**
 * Profils de déplacement servis. OSRM ne fournit que car, bicycle et foot : un profil
 * « motorbike » demande un profil Lua dédié et un second jeu de données (ADR-045, reste à faire).
 */
export const TRAVEL_PROFILES = ['car'] as const;
export type TravelProfile = (typeof TRAVEL_PROFILES)[number];
export const DEFAULT_TRAVEL_PROFILE: TravelProfile = 'car';

/** Points d'un itinéraire (départ, étapes, arrivée). */
export const MIN_ROUTE_POINTS = 2;
export const MAX_ROUTE_POINTS = 25;
/** Origines, et destinations, d'une matrice : 50 points au plus, sous la limite d'OSRM (100). */
export const MAX_MATRIX_SIDE = 25;

/** Distance en mètres et durée en secondes, arrondies à l'entier. */
export interface Leg {
  distanceMeters: number;
  durationSeconds: number;
}

/** Cellule d'une matrice : null si aucun itinéraire ne relie l'origine à la destination. */
export type MatrixCell = Leg | null;

export interface NearestRoad {
  point: GeoPoint;
  /** Distance à vol d'oiseau entre le point demandé et le réseau routier, en mètres. */
  distanceMeters: number;
  /** Nom de la voie, vide si inconnu. */
  roadName: string;
}
