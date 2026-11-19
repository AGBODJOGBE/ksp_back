import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de CatalogAdminService — back-office : catalogue, tarifs, compétences, jours
 * fériés, zones (UC-NT-25 à 29). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore
 * livrée répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.CatalogAdminServiceControllerMethods()
export class CatalogAdminGrpcController implements cleaningV1.CatalogAdminServiceController {
  listPlaceCategories(): Promise<cleaningV1.ListPlaceCategoriesResponse> {
    return notImplemented('ListPlaceCategories');
  }

  createPlaceCategory(): Promise<cleaningV1.CreatePlaceCategoryResponse> {
    return notImplemented('CreatePlaceCategory');
  }

  getPlaceCategory(): Promise<cleaningV1.GetPlaceCategoryResponse> {
    return notImplemented('GetPlaceCategory');
  }

  updatePlaceCategory(): Promise<cleaningV1.UpdatePlaceCategoryResponse> {
    return notImplemented('UpdatePlaceCategory');
  }

  listPlaceTypes(): Promise<cleaningV1.ListPlaceTypesResponse> {
    return notImplemented('ListPlaceTypes');
  }

  createPlaceType(): Promise<cleaningV1.CreatePlaceTypeResponse> {
    return notImplemented('CreatePlaceType');
  }

  getPlaceType(): Promise<cleaningV1.GetPlaceTypeResponse> {
    return notImplemented('GetPlaceType');
  }

  updatePlaceType(): Promise<cleaningV1.UpdatePlaceTypeResponse> {
    return notImplemented('UpdatePlaceType');
  }

  listCleaningTypes(): Promise<cleaningV1.ListCleaningTypesResponse> {
    return notImplemented('ListCleaningTypes');
  }

  createCleaningType(): Promise<cleaningV1.CreateCleaningTypeResponse> {
    return notImplemented('CreateCleaningType');
  }

  getCleaningType(): Promise<cleaningV1.GetCleaningTypeResponse> {
    return notImplemented('GetCleaningType');
  }

  updateCleaningType(): Promise<cleaningV1.UpdateCleaningTypeResponse> {
    return notImplemented('UpdateCleaningType');
  }

  listParameters(): Promise<cleaningV1.ListParametersResponse> {
    return notImplemented('ListParameters');
  }

  createParameter(): Promise<cleaningV1.CreateParameterResponse> {
    return notImplemented('CreateParameter');
  }

  getParameter(): Promise<cleaningV1.GetParameterResponse> {
    return notImplemented('GetParameter');
  }

  updateParameter(): Promise<cleaningV1.UpdateParameterResponse> {
    return notImplemented('UpdateParameter');
  }

  listOffers(): Promise<cleaningV1.ListOffersResponse> {
    return notImplemented('ListOffers');
  }

  createOffer(): Promise<cleaningV1.CreateOfferResponse> {
    return notImplemented('CreateOffer');
  }

  getOffer(): Promise<cleaningV1.GetOfferResponse> {
    return notImplemented('GetOffer');
  }

  updateOffer(): Promise<cleaningV1.UpdateOfferResponse> {
    return notImplemented('UpdateOffer');
  }

  listTariffs(): Promise<cleaningV1.ListTariffsResponse> {
    return notImplemented('ListTariffs');
  }

  createTariffDraft(): Promise<cleaningV1.CreateTariffDraftResponse> {
    return notImplemented('CreateTariffDraft');
  }

  updateTariffDraft(): Promise<cleaningV1.UpdateTariffDraftResponse> {
    return notImplemented('UpdateTariffDraft');
  }

  publishTariff(): Promise<cleaningV1.PublishTariffResponse> {
    return notImplemented('PublishTariff');
  }

  simulateWithDrafts(): Promise<cleaningV1.SimulateWithDraftsResponse> {
    return notImplemented('SimulateWithDrafts');
  }

  listSkills(): Promise<cleaningV1.ListSkillsResponse> {
    return notImplemented('ListSkills');
  }

  createSkill(): Promise<cleaningV1.CreateSkillResponse> {
    return notImplemented('CreateSkill');
  }

  updateSkill(): Promise<cleaningV1.UpdateSkillResponse> {
    return notImplemented('UpdateSkill');
  }

  listHolidays(): Promise<cleaningV1.ListHolidaysResponse> {
    return notImplemented('ListHolidays');
  }

  createHoliday(): Promise<cleaningV1.CreateHolidayResponse> {
    return notImplemented('CreateHoliday');
  }

  deleteHoliday(): Promise<cleaningV1.DeleteHolidayResponse> {
    return notImplemented('DeleteHoliday');
  }

  listZones(): Promise<cleaningV1.ListZonesResponse> {
    return notImplemented('ListZones');
  }

  createZone(): Promise<cleaningV1.CreateZoneResponse> {
    return notImplemented('CreateZone');
  }

  updateZone(): Promise<cleaningV1.UpdateZoneResponse> {
    return notImplemented('UpdateZone');
  }

  setZoneActive(): Promise<cleaningV1.SetZoneActiveResponse> {
    return notImplemented('SetZoneActive');
  }

  listCommunes(): Promise<cleaningV1.ListCommunesResponse> {
    return notImplemented('ListCommunes');
  }
}
