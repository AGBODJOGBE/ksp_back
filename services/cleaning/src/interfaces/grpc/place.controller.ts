import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { LOT_C_USE_CASES, type LotCUseCases } from '../../application/requests/lot-c-use-cases';
import { declaredFromProto, opt, presentPlace } from './case-values.presenters';

/**
 * Adaptateur gRPC de PlaceService — lieux du client, « Mes lieux » (UC-NT-03), et vérification
 * d'une position (POST /places/locate). Lot C. Les coordonnées ne sont jamais journalisées.
 */
@Controller()
@cleaningV1.PlaceServiceControllerMethods()
export class PlaceGrpcController implements cleaningV1.PlaceServiceController {
  constructor(@Inject(LOT_C_USE_CASES) private readonly useCases: LotCUseCases) {}

  async listMyPlaces(request: cleaningV1.ListMyPlacesRequest): Promise<cleaningV1.ListMyPlacesResponse> {
    const page = await this.useCases.places.list(request);
    return { items: page.items.map(presentPlace), nextCursor: page.nextCursor ?? '', total: page.total };
  }

  async createPlace(request: cleaningV1.CreatePlaceRequest): Promise<cleaningV1.CreatePlaceResponse> {
    const view = await this.useCases.places.create({
      idempotencyKey: request.idempotencyKey,
      name: request.name,
      placeTypeId: request.placeTypeId,
      latitude: request.latitude,
      longitude: request.longitude,
      accuracyMeters: request.accuracyMeters,
      landmark: request.landmark,
      address: request.address,
      declaredValues: declaredFromProto(request.declaredValues),
    });
    return { place: presentPlace(view) };
  }

  async getMyPlace(request: cleaningV1.GetMyPlaceRequest): Promise<cleaningV1.GetMyPlaceResponse> {
    return { place: presentPlace(await this.useCases.places.get(request.placeId)) };
  }

  async updatePlace(request: cleaningV1.UpdatePlaceRequest): Promise<cleaningV1.UpdatePlaceResponse> {
    const view = await this.useCases.places.update({
      placeId: request.placeId,
      name: request.name,
      latitude: request.latitude,
      longitude: request.longitude,
      accuracyMeters: request.accuracyMeters,
      landmark: request.landmark,
      address: request.address,
      declaredValues: declaredFromProto(request.declaredValues),
    });
    return { place: presentPlace(view) };
  }

  async archivePlace(request: cleaningV1.ArchivePlaceRequest): Promise<cleaningV1.ArchivePlaceResponse> {
    return { place: presentPlace(await this.useCases.places.archive(request.placeId)) };
  }

  async locatePoint(request: cleaningV1.LocatePointRequest): Promise<cleaningV1.LocatePointResponse> {
    const located = await this.useCases.places.locatePoint(request);
    return {
      pointLocation: {
        communeKey: opt(located.commune?.key),
        communeName: opt(located.commune?.name),
        served: located.served,
        readableAddress: opt(located.readableAddress),
      },
    };
  }
}
