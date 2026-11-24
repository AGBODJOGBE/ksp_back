import { placeTypeHiddenReasons, publicCatalog } from '../../domain/catalog/visibility';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from '../shared/errors';
import {
  type CleaningType,
  type Parameter,
  type PlaceCategory,
  type PlaceType,
  type Zone,
} from './catalog.ports';

/**
 * UC-NT-01 — Catalogue public, sans compte ni prix (R-CA-01, R-CA-02, R-CA-04, R-CA-05, R-CA-06,
 * R-CA-12, R-FV-01, R-ZN-01) : seuls les éléments actifs et visibles en cascade ; une valeur de choix
 * désactivée est masquée.
 */
export interface PublicPlaceTypeDetail {
  placeType: PlaceType;
  parameters: Parameter[];
  offers: { offerId: string; cleaningType: CleaningType; extraParameters: Parameter[] }[];
  /** Frais de la catégorie (ou par défaut), hors majoration de commune. */
  visitFee: number;
}

const publicParameter = (parameter: Parameter): Parameter => ({
  ...parameter,
  choices: parameter.choices.filter((choice) => choice.active),
});

export class PublicCatalogUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async listCatalog(): Promise<{ category: PlaceCategory; placeTypes: PlaceType[] }[]> {
    const [categories, placeTypes, offers, types] = await Promise.all([
      this.deps.places.listCategories(),
      this.deps.places.listPlaceTypes(),
      this.deps.offers.listOffers(),
      this.deps.cleaningTypes.listCleaningTypes(),
    ]);
    const categoryActive = new Map(categories.map((category) => [category.id, category.active]));
    const typeActive = new Map(types.map((type) => [type.id, type.active]));
    const chained = placeTypes.map((placeType) => ({
      ...placeType,
      chain: {
        active: placeType.active,
        categoryActive: categoryActive.get(placeType.categoryId) ?? false,
        isOther: placeType.isOther,
        offers: offers
          .filter((offer) => offer.placeTypeId === placeType.id)
          .map((offer) => ({
            active: offer.active,
            typeActive: typeActive.get(offer.cleaningTypeId) ?? false,
          })),
      },
    }));
    return publicCatalog(categories, chained).map(({ category, placeTypes: visible }) => ({
      category,
      placeTypes: visible.map(({ chain: _chain, ...placeType }) => placeType),
    }));
  }

  async getPlaceType(id: string): Promise<PublicPlaceTypeDetail> {
    const placeType = await this.deps.places.getPlaceType(id);
    if (!placeType) throw CleaningErrors.placeTypeNotFound();
    const [category, parameters, offers, types, settings] = await Promise.all([
      this.deps.places.getCategory(placeType.categoryId),
      this.deps.parameters.listParameters(),
      this.deps.offers.listOffers({ placeTypeId: placeType.id }),
      this.deps.cleaningTypes.listCleaningTypes(),
      this.deps.settings.catalogSettings(),
    ]);
    const typeById = new Map(types.map((type) => [type.id, type]));
    const visibleOffers = offers
      .filter((offer) => offer.active && typeById.get(offer.cleaningTypeId)?.active)
      .sort((a, b) => a.order - b.order || a.createdAt.getTime() - b.createdAt.getTime());
    const hidden = placeTypeHiddenReasons({
      active: placeType.active,
      categoryActive: category?.active ?? false,
      isOther: placeType.isOther,
      offers: visibleOffers.map(() => ({ active: true, typeActive: true })),
    });
    if (hidden.length) throw CleaningErrors.placeTypeNotFound();
    const parameterById = new Map(parameters.map((parameter) => [parameter.id, parameter]));
    const activeOf = (links: readonly { parameterId: string }[]) =>
      links
        .map((link) => parameterById.get(link.parameterId))
        .filter((parameter): parameter is Parameter => !!parameter?.active)
        .map(publicParameter);
    return {
      placeType,
      parameters: activeOf(placeType.parameters),
      offers: visibleOffers.map((offer) => ({
        offerId: offer.id,
        cleaningType: typeById.get(offer.cleaningTypeId) as CleaningType,
        extraParameters: activeOf(offer.extraParameters),
      })),
      visitFee: category?.visitFee ?? settings.defaultVisitFee,
    };
  }

  /** Communes desservies (zones actives), par nom. */
  async listServedZones(): Promise<Zone[]> {
    return (await this.deps.zones.listZones())
      .filter((zone) => zone.active)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }
}
