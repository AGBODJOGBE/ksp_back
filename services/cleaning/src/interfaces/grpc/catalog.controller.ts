import { cleaningV1 } from '@ksp/contracts';
import { AllowedCallers } from '@ksp/platform';
import { Controller, Inject } from '@nestjs/common';
import { CATALOG_USE_CASES, type CatalogUseCases } from '../../application/catalog/catalog-use-cases';
import { money, presentPublicParameter } from './catalog.presenters';
import {
  presentSchedulePreview,
  presentSimulation,
  scheduleFromProto,
  valuesFromProto,
} from './simulation.presenters';

/**
 * Adaptateur gRPC de CatalogService — catalogue, simulateur et aperçu des dates — public, sans
 * compte (UC-NT-01, 02). Appelé par la gateway seule, qui limite le simulateur à 30 calculs par
 * minute et par adresse. Aucune photo publique : file ne connaît pas encore d'objet « lieu du
 * catalogue » (photoUrl absent).
 */
@Controller()
@AllowedCallers('gateway')
@cleaningV1.CatalogServiceControllerMethods()
export class CatalogGrpcController implements cleaningV1.CatalogServiceController {
  constructor(@Inject(CATALOG_USE_CASES) private readonly useCases: CatalogUseCases) {}

  async listCatalog(): Promise<cleaningV1.ListCatalogResponse> {
    const catalog = await this.useCases.publicCatalog.listCatalog();
    return {
      categories: catalog.map(({ category, placeTypes }) => ({
        id: category.id,
        code: category.code,
        name: category.name,
        icon: category.icon ?? undefined,
        placeTypes: placeTypes.map((placeType) => ({
          id: placeType.id,
          code: placeType.code,
          name: placeType.name,
          icon: placeType.icon ?? undefined,
          description: placeType.description ?? undefined,
          freeDescription: placeType.isOther,
        })),
      })),
    };
  }

  async getCatalogPlaceType(
    request: cleaningV1.GetCatalogPlaceTypeRequest,
  ): Promise<cleaningV1.GetCatalogPlaceTypeResponse> {
    const detail = await this.useCases.publicCatalog.getPlaceType(request.placeTypeId);
    const { placeType } = detail;
    return {
      publicPlaceTypeDetail: {
        placeType: {
          id: placeType.id,
          code: placeType.code,
          name: placeType.name,
          icon: placeType.icon ?? undefined,
          description: placeType.description ?? undefined,
          freeDescription: placeType.isOther,
        },
        categoryId: placeType.categoryId,
        parameters: detail.parameters.map(presentPublicParameter),
        offers: detail.offers.map((offer) => ({
          offerId: offer.offerId,
          cleaningType: {
            id: offer.cleaningType.id,
            code: offer.cleaningType.code,
            name: offer.cleaningType.name,
            description: offer.cleaningType.description ?? undefined,
            icon: offer.cleaningType.icon ?? undefined,
            isPack: offer.cleaningType.isPack,
            packItemIds: offer.cleaningType.packItemIds,
          },
          extraParameters: offer.extraParameters.map(presentPublicParameter),
        })),
        visitFee: money(detail.visitFee),
      },
    };
  }

  async listServedZones(): Promise<cleaningV1.ListServedZonesResponse> {
    const zones = await this.useCases.publicCatalog.listServedZones();
    return { zones: zones.map((zone) => ({ communeKey: zone.communeKey, name: zone.name })) };
  }

  async simulate(request: cleaningV1.SimulateRequest): Promise<cleaningV1.SimulateResponse> {
    const result = await this.useCases.simulate.execute({
      placeTypeId: request.placeTypeId,
      cleaningTypeIds: request.cleaningTypeIds,
      values: valuesFromProto(request.values),
      schedule: scheduleFromProto(request.schedule),
      communeKey: request.communeKey,
    });
    return { simulation: presentSimulation(result) };
  }

  async previewSchedule(
    request: cleaningV1.PreviewScheduleRequest,
  ): Promise<cleaningV1.PreviewScheduleResponse> {
    const preview = await this.useCases.previewSchedule.execute({
      schedule: scheduleFromProto(request.schedule),
    });
    return { schedulePreview: presentSchedulePreview(preview) };
  }
}
