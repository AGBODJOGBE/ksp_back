import { type GeoPoint } from '../domain/geo-point';
import {
  type Leg,
  type MatrixCell,
  MAX_MATRIX_SIDE,
  MAX_ROUTE_POINTS,
  MIN_ROUTE_POINTS,
  type NearestRoad,
} from '../domain/routing';
import { requirePoint, requirePoints, requireProfile } from './input';
import { type RoutingEngine } from './ports';

type PointInput = Partial<GeoPoint>;

/** Route : distance et durée d'un itinéraire passant par les points, dans l'ordre. */
export class RouteUseCase {
  constructor(private readonly engine: RoutingEngine) {}

  async execute(input: { points?: readonly PointInput[]; profile?: string }): Promise<Leg> {
    const points = requirePoints('points', input.points, MIN_ROUTE_POINTS, MAX_ROUTE_POINTS);
    return this.engine.route(points, requireProfile(input.profile));
  }
}

/** DistanceMatrix : distance et durée de chaque origine vers chaque destination. */
export class DistanceMatrixUseCase {
  constructor(private readonly engine: RoutingEngine) {}

  async execute(input: {
    origins?: readonly PointInput[];
    destinations?: readonly PointInput[];
    profile?: string;
  }): Promise<MatrixCell[][]> {
    const origins = requirePoints('origins', input.origins, 1, MAX_MATRIX_SIDE);
    const destinations = requirePoints('destinations', input.destinations, 1, MAX_MATRIX_SIDE);
    return this.engine.matrix(origins, destinations, requireProfile(input.profile));
  }
}

/** Nearest : point le plus proche sur le réseau routier. */
export class NearestUseCase {
  constructor(private readonly engine: RoutingEngine) {}

  async execute(input: { point?: PointInput | undefined; profile?: string }): Promise<NearestRoad> {
    return this.engine.nearest(requirePoint('point', input.point), requireProfile(input.profile));
  }
}
