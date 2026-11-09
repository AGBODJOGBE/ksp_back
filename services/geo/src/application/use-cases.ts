import { ReverseGeocodeUseCase } from './geocoding.use-case';
import { type ReverseGeocoder, type RoutingEngine } from './ports';
import { DistanceMatrixUseCase, NearestUseCase, RouteUseCase } from './routing.use-cases';

export interface GeoDeps {
  geocoder: ReverseGeocoder;
  routing: RoutingEngine;
}

/** Cas d'usage du service (une classe chacun), reliés aux mêmes dépendances. */
export function createUseCases(deps: GeoDeps) {
  return {
    reverseGeocode: new ReverseGeocodeUseCase(deps.geocoder),
    route: new RouteUseCase(deps.routing),
    distanceMatrix: new DistanceMatrixUseCase(deps.routing),
    nearest: new NearestUseCase(deps.routing),
  };
}

export type GeoUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection des cas d'usage (racine de composition). */
export const GEO_USE_CASES = Symbol('GEO_USE_CASES');
