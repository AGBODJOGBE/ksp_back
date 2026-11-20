import { offerProblems } from '../../domain/catalog/entries';
import { offerHiddenReasons, type VisibilityReason } from '../../domain/catalog/visibility';
import { type TeamRuleBracket } from '../../domain/pricing/types';
import { type CleaningDeps } from '../deps';
import { DuplicateKeyError } from '../ports';
import { requireStaff } from '../shared/access';
import { CleaningErrors, throwFirstProblem } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { type Page, pageOf, parsePage, parseSort } from '../shared/paging';
import { auditOf } from './audit';
import { type Offer, type TariffVersion } from './catalog.ports';
import { type PageInput, resolveParameters } from './places.use-cases';

/**
 * UC-NT-28 — Gérer les offres (R-CA-02, R-CA-03, R-CA-10, R-CA-12, R-CA-13) : une offre par lieu et
 * type (CLEANING_CODE_ALREADY_USED), créée inactive ; le lieu et le type ne se modifient pas. Sans
 * tarif publié, l'offre reste « sur devis ».
 */
export interface OfferView extends Offer {
  currentTariffVersion: number | null;
  draftTariffVersion: number | null;
  hiddenReasons: VisibilityReason[];
}

export interface OfferFields {
  /** Absent : inchangé (modification) ; présent : remplace la liste. */
  extraParameterIds?: string[] | undefined;
  teamRule?: TeamRuleBracket[] | undefined;
  order?: number | undefined;
  active?: boolean | undefined;
}

const TRACED = ['placeTypeId', 'cleaningTypeId', 'extraParameterIds', 'teamRule', 'order', 'active'];

const snapshot = (offer: Offer) => ({
  placeTypeId: offer.placeTypeId,
  cleaningTypeId: offer.cleaningTypeId,
  extraParameterIds: offer.extraParameters.map((link) => link.parameterId),
  teamRule: offer.teamRule,
  order: offer.order,
  active: offer.active,
});

/** Version publiée en vigueur et brouillon en cours d'une offre. */
export function tariffVersionsOf(tariffs: readonly TariffVersion[], offerId: string) {
  const own = tariffs.filter((tariff) => tariff.offerId === offerId);
  return {
    currentTariffVersion: own.find((tariff) => tariff.status === 'published')?.version ?? null,
    draftTariffVersion: own.find((tariff) => tariff.status === 'draft')?.version ?? null,
  };
}

export class OffersUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(
    input: PageInput & { placeTypeId?: string | undefined; cleaningTypeId?: string | undefined },
  ): Promise<Page<OfferView>> {
    requireStaff();
    const page = parsePage(input);
    parseSort(input.sort, ['createdAt']);
    const offers = await this.deps.offers.listOffers({
      ...(input.placeTypeId ? { placeTypeId: input.placeTypeId } : {}),
      ...(input.cleaningTypeId ? { cleaningTypeId: input.cleaningTypeId } : {}),
    });
    const sorted = offers.sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    );
    const slice = pageOf(sorted, page);
    return { ...slice, items: await this.views(slice.items) };
  }

  async get(id: string): Promise<OfferView> {
    requireStaff();
    const offer = await this.deps.offers.getOffer(id);
    if (!offer) throw CleaningErrors.offerNotFound();
    return (await this.views([offer]))[0] as OfferView;
  }

  async create(
    input: OfferFields & { idempotencyKey: string; placeTypeId: string; cleaningTypeId: string },
  ): Promise<OfferView> {
    const { userId } = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.offer.create',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.get(String(response.id)),
      run: async (stub) => {
        if (!(await this.deps.places.getPlaceType(input.placeTypeId)))
          throw CleaningErrors.placeTypeNotFound();
        const type = await this.deps.cleaningTypes.getCleaningType(input.cleaningTypeId);
        if (!type) throw CleaningErrors.cleaningTypeNotFound();
        const offer = await this.merge(
          {
            id: this.deps.ids.next(),
            placeTypeId: input.placeTypeId,
            cleaningTypeId: input.cleaningTypeId,
            extraParameters: [],
            teamRule: [],
            order: 0,
            active: false,
            createdAt: now,
            updatedAt: now,
            updatedBy: userId,
          },
          { ...input, extraParameterIds: input.extraParameterIds ?? [] },
          now,
          userId,
        );
        try {
          await this.deps.offers.saveOffer(offer, 'create', {
            events: [],
            audit: [this.audit(userId, 'catalog.offer.created', null, offer, now)],
            idempotency: stub({ id: offer.id }),
          });
        } catch (error) {
          if (error instanceof DuplicateKeyError && error.key === 'code')
            throw CleaningErrors.codeAlreadyUsed(type.code);
          throw error;
        }
        return this.get(offer.id);
      },
    });
  }

  async update(input: OfferFields & { id: string }): Promise<OfferView> {
    const { userId } = requireStaff();
    const before = await this.deps.offers.getOffer(input.id);
    if (!before) throw CleaningErrors.offerNotFound();
    const now = this.deps.clock.now();
    const after = await this.merge(before, input, now, userId);
    await this.deps.offers.saveOffer(after, 'update', {
      events: [],
      audit: [this.audit(userId, 'catalog.offer.updated', before, after, now)],
    });
    return this.get(after.id);
  }

  private async merge(base: Offer, input: OfferFields, now: Date, userId: string): Promise<Offer> {
    const extraIds = input.extraParameterIds ?? base.extraParameters.map((link) => link.parameterId);
    const extra = await resolveParameters(this.deps, extraIds);
    const offer: Offer = {
      ...base,
      extraParameters: extra.map((parameter) => ({ parameterId: parameter.id, code: parameter.code })),
      ...(input.teamRule !== undefined
        ? { teamRule: input.teamRule.map((bracket) => ({ ...bracket })) }
        : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: now,
      updatedBy: userId,
    };
    throwFirstProblem(offerProblems({ ...offer, extraParameterIds: extraIds }));
    return offer;
  }

  private audit(userId: string, action: string, before: Offer | null, after: Offer, at: Date) {
    return auditOf({
      actorId: userId,
      action,
      entityType: 'offer',
      entityId: after.id,
      at,
      before: before && snapshot(before),
      after: snapshot(after),
      traced: TRACED,
    });
  }

  private async views(offers: Offer[]): Promise<OfferView[]> {
    const [tariffs, placeTypes, categories, types] = await Promise.all([
      this.deps.offers.listTariffs(offers.map((offer) => offer.id)),
      this.deps.places.listPlaceTypes(),
      this.deps.places.listCategories(),
      this.deps.cleaningTypes.listCleaningTypes(),
    ]);
    const placeTypeById = new Map(placeTypes.map((placeType) => [placeType.id, placeType]));
    const categoryActive = new Map(categories.map((category) => [category.id, category.active]));
    const typeActive = new Map(types.map((type) => [type.id, type.active]));
    return offers.map((offer) => {
      const placeType = placeTypeById.get(offer.placeTypeId);
      return {
        ...offer,
        ...tariffVersionsOf(tariffs, offer.id),
        hiddenReasons: offerHiddenReasons({
          active: offer.active,
          typeActive: typeActive.get(offer.cleaningTypeId) ?? false,
          placeTypeActive: placeType?.active ?? false,
          categoryActive: (placeType && categoryActive.get(placeType.categoryId)) ?? false,
        }),
      };
    });
  }
}
