import { geoV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { GEO_USE_CASES, type GeoUseCases } from '../../application/use-cases';
import { type Leg } from '../../domain/routing';

const leg = (value: Leg) => ({
  distanceMeters: value.distanceMeters,
  durationSeconds: value.durationSeconds,
});

/**
 * Adaptateur gRPC : traduit chaque appel en cas d'usage (couche application). Appelants : services
 * métier munis d'un jeton de service d'audience « geo » (vérifié par le kit). Aucune règle ici.
 */
@Controller()
@geoV1.GeoServiceControllerMethods()
export class GeoGrpcController implements geoV1.GeoServiceController {
  constructor(@Inject(GEO_USE_CASES) private readonly useCases: GeoUseCases) {}

  async reverseGeocode(request: geoV1.ReverseGeocodeRequest): Promise<geoV1.ReverseGeocodeResponse> {
    const place = await this.useCases.reverseGeocode.execute({ point: request.point });
    return {
      communes: place?.communes ?? [],
      displayAddress: place?.displayAddress ?? '',
      provider: place?.provider ?? '',
    };
  }

  async route(request: geoV1.RouteRequest): Promise<geoV1.RouteResponse> {
    return leg(await this.useCases.route.execute(request));
  }

  async distanceMatrix(request: geoV1.DistanceMatrixRequest): Promise<geoV1.DistanceMatrixResponse> {
    const rows = await this.useCases.distanceMatrix.execute(request);
    return {
      rows: rows.map((cells) => ({
        cells: cells.map((cell) =>
          cell
            ? { reachable: true, ...leg(cell) }
            : { reachable: false, distanceMeters: 0, durationSeconds: 0 },
        ),
      })),
    };
  }

  async nearest(request: geoV1.NearestRequest): Promise<geoV1.NearestResponse> {
    const road = await this.useCases.nearest.execute(request);
    return { point: road.point, distanceMeters: road.distanceMeters, roadName: road.roadName };
  }
}
