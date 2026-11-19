import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de CatalogService — catalogue, simulateur et aperçu des dates — public, sans
 * compte (UC-NT-01, 02). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore livrée
 * répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.CatalogServiceControllerMethods()
export class CatalogGrpcController implements cleaningV1.CatalogServiceController {
  listCatalog(): Promise<cleaningV1.ListCatalogResponse> {
    return notImplemented('ListCatalog');
  }

  getCatalogPlaceType(): Promise<cleaningV1.GetCatalogPlaceTypeResponse> {
    return notImplemented('GetCatalogPlaceType');
  }

  listServedZones(): Promise<cleaningV1.ListServedZonesResponse> {
    return notImplemented('ListServedZones');
  }

  simulate(): Promise<cleaningV1.SimulateResponse> {
    return notImplemented('Simulate');
  }

  previewSchedule(): Promise<cleaningV1.PreviewScheduleResponse> {
    return notImplemented('PreviewSchedule');
  }
}
