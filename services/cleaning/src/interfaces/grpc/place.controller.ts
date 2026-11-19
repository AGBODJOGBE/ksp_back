import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de PlaceService — lieux du client, « Mes lieux » (UC-NT-03). Métier v2 livré lot
 * par lot (ADR-054) : chaque méthode pas encore livrée répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.PlaceServiceControllerMethods()
export class PlaceGrpcController implements cleaningV1.PlaceServiceController {
  listMyPlaces(): Promise<cleaningV1.ListMyPlacesResponse> {
    return notImplemented('ListMyPlaces');
  }

  createPlace(): Promise<cleaningV1.CreatePlaceResponse> {
    return notImplemented('CreatePlace');
  }

  getMyPlace(): Promise<cleaningV1.GetMyPlaceResponse> {
    return notImplemented('GetMyPlace');
  }

  updatePlace(): Promise<cleaningV1.UpdatePlaceResponse> {
    return notImplemented('UpdatePlace');
  }

  archivePlace(): Promise<cleaningV1.ArchivePlaceResponse> {
    return notImplemented('ArchivePlace');
  }

  locatePoint(): Promise<cleaningV1.LocatePointResponse> {
    return notImplemented('LocatePoint');
  }
}
