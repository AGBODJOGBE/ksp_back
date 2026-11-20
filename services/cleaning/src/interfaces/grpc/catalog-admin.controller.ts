import { cleaningV1 } from '@ksp/contracts';
import { AllowedCallers } from '@ksp/platform';
import { Controller, Inject } from '@nestjs/common';
import { CATALOG_USE_CASES, type CatalogUseCases } from '../../application/catalog/catalog-use-cases';
import { type TariffFields } from '../../application/catalog/tariffs.use-cases';
import { type Page } from '../../application/shared/paging';
import { type TeamRuleBracket } from '../../domain/pricing/types';
import {
  type Names,
  presentCategory,
  presentCleaningType,
  presentCommune,
  presentHoliday,
  presentOffer,
  presentParameter,
  presentPlaceType,
  presentSkill,
  presentTariff,
  presentZone,
} from './catalog.presenters';
import { presentSimulation, scheduleFromProto, valuesFromProto } from './simulation.presenters';

/** Règle d'équipe reçue : `toArea` absent vaut « sans limite ». */
const teamRule = (brackets: cleaningV1.TeamRuleBracket[]): TeamRuleBracket[] =>
  brackets.map((bracket) => ({ ...bracket, toArea: bracket.toArea ?? null }));

const tariffFields = (
  request: cleaningV1.CreateTariffDraftRequest | cleaningV1.UpdateTariffDraftRequest,
): TariffFields => ({
  baseParameterCode: request.baseParameterCode,
  brackets: request.brackets.map((bracket) => ({ ...bracket, amount: bracket.amount?.amount })),
  supplements: request.supplements.map((supplement) => ({
    ...supplement,
    amount: supplement.amount?.amount,
  })),
  minimum: request.minimum?.amount,
  frequencyCoefficients: request.frequencyCoefficients,
  packDiscountBps: request.packDiscountBps,
});

/**
 * Adaptateur gRPC de CatalogAdminService — back-office : catalogue, tarifs, compétences, jours
 * fériés, zones (UC-NT-25 à 29). Réservé à la gateway, qui contrôle la permission de la route ; le
 * compte et sa double authentification sont revérifiés par chaque cas d'usage. Chaque réponse porte
 * les noms des auteurs (ADR-029).
 */
@Controller()
@AllowedCallers('gateway')
@cleaningV1.CatalogAdminServiceControllerMethods()
export class CatalogAdminGrpcController implements cleaningV1.CatalogAdminServiceController {
  constructor(@Inject(CATALOG_USE_CASES) private readonly useCases: CatalogUseCases) {}

  /** Auteurs cités par les éléments rendus : modification, création, publication. */
  private names(entries: readonly object[]) {
    return this.useCases.userNames(
      entries.flatMap((entry) => {
        const authors = entry as {
          updatedBy?: string | null;
          createdBy?: string;
          publishedBy?: string | null;
        };
        return [authors.updatedBy ?? null, authors.createdBy ?? null, authors.publishedBy ?? null];
      }),
    );
  }

  private async page<T extends object, M>(page: Page<T>, present: (item: T, names: Names) => M) {
    const names = await this.names(page.items);
    return {
      items: page.items.map((item) => present(item, names)),
      nextCursor: page.nextCursor ?? '',
      total: page.total,
    };
  }

  private async one<T extends object, M>(item: T, present: (item: T, names: Names) => M): Promise<M> {
    return present(item, await this.names([item]));
  }

  // --- Catégories et lieux (UC-NT-25) ---------------------------------------------------------

  async listPlaceCategories(request: cleaningV1.ListPlaceCategoriesRequest) {
    return this.page(await this.useCases.categories.list(request), presentCategory);
  }

  async createPlaceCategory(request: cleaningV1.CreatePlaceCategoryRequest) {
    const category = await this.useCases.categories.create({
      ...request,
      visitFee: request.visitFee?.amount,
    });
    return { placeCategory: await this.one(category, presentCategory) };
  }

  async getPlaceCategory(request: cleaningV1.GetPlaceCategoryRequest) {
    return { placeCategory: await this.one(await this.useCases.categories.get(request.id), presentCategory) };
  }

  async updatePlaceCategory(request: cleaningV1.UpdatePlaceCategoryRequest) {
    const category = await this.useCases.categories.update({
      ...request,
      visitFee: request.visitFee?.amount,
    });
    return { placeCategory: await this.one(category, presentCategory) };
  }

  async listPlaceTypes(request: cleaningV1.ListPlaceTypesRequest) {
    return this.page(await this.useCases.placeTypes.list(request), presentPlaceType);
  }

  async createPlaceType(request: cleaningV1.CreatePlaceTypeRequest) {
    return { placeType: await this.one(await this.useCases.placeTypes.create(request), presentPlaceType) };
  }

  async getPlaceType(request: cleaningV1.GetPlaceTypeRequest) {
    return { placeType: await this.one(await this.useCases.placeTypes.get(request.id), presentPlaceType) };
  }

  async updatePlaceType(request: cleaningV1.UpdatePlaceTypeRequest) {
    const placeType = await this.useCases.placeTypes.update({
      ...request,
      parameterIds: request.parameterIds?.items,
    });
    return { placeType: await this.one(placeType, presentPlaceType) };
  }

  // --- Types de nettoyage et packs (UC-NT-26) -------------------------------------------------

  async listCleaningTypes(request: cleaningV1.ListCleaningTypesRequest) {
    return this.page(await this.useCases.cleaningTypes.list(request), presentCleaningType);
  }

  async createCleaningType(request: cleaningV1.CreateCleaningTypeRequest) {
    return {
      cleaningType: await this.one(await this.useCases.cleaningTypes.create(request), presentCleaningType),
    };
  }

  async getCleaningType(request: cleaningV1.GetCleaningTypeRequest) {
    return {
      cleaningType: await this.one(await this.useCases.cleaningTypes.get(request.id), presentCleaningType),
    };
  }

  async updateCleaningType(request: cleaningV1.UpdateCleaningTypeRequest) {
    const type = await this.useCases.cleaningTypes.update({
      ...request,
      checklist: request.checklist?.items,
      packItemIds: request.packItemIds?.items,
    });
    return { cleaningType: await this.one(type, presentCleaningType) };
  }

  // --- Paramètres (UC-NT-27) ------------------------------------------------------------------

  async listParameters(request: cleaningV1.ListParametersRequest) {
    return this.page(await this.useCases.parameters.list(request), presentParameter);
  }

  async createParameter(request: cleaningV1.CreateParameterRequest) {
    return {
      parameterDefinition: await this.one(await this.useCases.parameters.create(request), presentParameter),
    };
  }

  async getParameter(request: cleaningV1.GetParameterRequest) {
    return {
      parameterDefinition: await this.one(await this.useCases.parameters.get(request.id), presentParameter),
    };
  }

  async updateParameter(request: cleaningV1.UpdateParameterRequest) {
    const parameter = await this.useCases.parameters.update({ ...request, choices: request.choices?.items });
    return { parameterDefinition: await this.one(parameter, presentParameter) };
  }

  // --- Offres, tarifs, simulateur de test (UC-NT-28) ------------------------------------------

  async listOffers(request: cleaningV1.ListOffersRequest) {
    return this.page(await this.useCases.offers.list(request), presentOffer);
  }

  async createOffer(request: cleaningV1.CreateOfferRequest) {
    const offer = await this.useCases.offers.create({ ...request, teamRule: teamRule(request.teamRule) });
    return { offer: await this.one(offer, presentOffer) };
  }

  async getOffer(request: cleaningV1.GetOfferRequest) {
    return { offer: await this.one(await this.useCases.offers.get(request.id), presentOffer) };
  }

  async updateOffer(request: cleaningV1.UpdateOfferRequest) {
    const offer = await this.useCases.offers.update({
      ...request,
      extraParameterIds: request.extraParameterIds?.items,
      teamRule: request.teamRule ? teamRule(request.teamRule.items) : undefined,
    });
    return { offer: await this.one(offer, presentOffer) };
  }

  async listTariffs(request: cleaningV1.ListTariffsRequest) {
    return this.page(await this.useCases.tariffs.list(request), presentTariff);
  }

  async createTariffDraft(request: cleaningV1.CreateTariffDraftRequest) {
    const tariff = await this.useCases.tariffs.createDraft({
      ...tariffFields(request),
      offerId: request.offerId,
      idempotencyKey: request.idempotencyKey,
    });
    return { tariff: await this.one(tariff, presentTariff) };
  }

  async updateTariffDraft(request: cleaningV1.UpdateTariffDraftRequest) {
    const tariff = await this.useCases.tariffs.updateDraft({
      ...tariffFields(request),
      offerId: request.offerId,
      version: request.version,
    });
    return { tariff: await this.one(tariff, presentTariff) };
  }

  async publishTariff(request: cleaningV1.PublishTariffRequest) {
    return { tariff: await this.one(await this.useCases.tariffs.publish(request), presentTariff) };
  }

  async simulateWithDrafts(request: cleaningV1.SimulateWithDraftsRequest) {
    const result = await this.useCases.simulateWithDrafts.execute({
      placeTypeId: request.placeTypeId,
      cleaningTypeIds: request.cleaningTypeIds,
      values: valuesFromProto(request.values),
      schedule: scheduleFromProto(request.schedule),
      communeKey: request.communeKey,
      draftTariffIds: request.draftTariffIds,
    });
    return { simulation: presentSimulation(result) };
  }

  // --- Compétences et jours fériés (UC-NT-25, 26) ---------------------------------------------

  async listSkills(request: cleaningV1.ListSkillsRequest) {
    const page = await this.useCases.skills.list(request);
    return { items: page.items.map(presentSkill), nextCursor: page.nextCursor ?? '', total: page.total };
  }

  async createSkill(request: cleaningV1.CreateSkillRequest) {
    return { skill: presentSkill(await this.useCases.skills.create(request)) };
  }

  async updateSkill(request: cleaningV1.UpdateSkillRequest) {
    return { skill: presentSkill(await this.useCases.skills.update(request)) };
  }

  async listHolidays(request: cleaningV1.ListHolidaysRequest) {
    const page = await this.useCases.holidays.list(request);
    return { items: page.items.map(presentHoliday), nextCursor: page.nextCursor ?? '', total: page.total };
  }

  async createHoliday(request: cleaningV1.CreateHolidayRequest) {
    return { holiday: presentHoliday(await this.useCases.holidays.create(request)) };
  }

  async deleteHoliday(request: cleaningV1.DeleteHolidayRequest) {
    await this.useCases.holidays.delete(request.holidayId);
    return {};
  }

  // --- Zones et communes (UC-NT-29) -----------------------------------------------------------

  async listZones(request: cleaningV1.ListZonesRequest) {
    return this.page(await this.useCases.zones.list(request), presentZone);
  }

  async createZone(request: cleaningV1.CreateZoneRequest) {
    const zone = await this.useCases.zones.create({
      ...request,
      visitFeeSurcharge: request.visitFeeSurcharge?.amount,
    });
    return { zone: await this.one(zone, presentZone) };
  }

  async updateZone(request: cleaningV1.UpdateZoneRequest) {
    const zone = await this.useCases.zones.update({
      ...request,
      visitFeeSurcharge: request.visitFeeSurcharge?.amount,
    });
    return { zone: await this.one(zone, presentZone) };
  }

  async setZoneActive(request: cleaningV1.SetZoneActiveRequest) {
    return { zone: await this.one(await this.useCases.zones.setActive(request), presentZone) };
  }

  async listCommunes() {
    return { communes: (await this.useCases.zones.listCommunes()).map(presentCommune) };
  }
}
