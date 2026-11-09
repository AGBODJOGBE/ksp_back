import { type GeocodedPlace } from '../domain/geocoding';
import { type GeoPoint } from '../domain/geo-point';
import { type Leg, type MatrixCell, type NearestRoad, type TravelProfile } from '../domain/routing';

/**
 * Géocodage inverse : noms de commune possibles d'un point. Null si aucun fournisseur ne répond ou
 * ne trouve ; jamais d'erreur. L'adaptateur ne journalise jamais les coordonnées.
 */
export interface ReverseGeocoder {
  reverse(point: GeoPoint): Promise<GeocodedPlace | null>;
}

/**
 * Moteur d'itinéraires (OSRM). Échecs rendus en erreurs du service (GeoErrors) : moteur absent ou
 * en panne (réessayable), itinéraire introuvable, point trop loin du réseau routier.
 */
export interface RoutingEngine {
  route(points: readonly GeoPoint[], profile: TravelProfile): Promise<Leg>;
  /** Une ligne par origine, une cellule par destination, dans l'ordre reçu. */
  matrix(
    origins: readonly GeoPoint[],
    destinations: readonly GeoPoint[],
    profile: TravelProfile,
  ): Promise<MatrixCell[][]>;
  nearest(point: GeoPoint, profile: TravelProfile): Promise<NearestRoad>;
}
