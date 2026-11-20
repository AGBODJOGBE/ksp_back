import { categoryProblems, placeTypeProblems } from '../../domain/catalog/entries';
import { placeTypeHiddenReasons, type VisibilityReason } from '../../domain/catalog/visibility';
import { type CleaningDeps } from '../deps';
import { DuplicateKeyError } from '../ports';
import { requireStaff } from '../shared/access';
import { CleaningErrors, throwFirstProblem } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { type Page, pageOf, parsePage, parseSort } from '../shared/paging';
import { auditOf } from './audit';
import { type Parameter, type PlaceCategory, type PlaceType } from './catalog.ports';

/**
 * UC-NT-25 — Gérer les lieux : catégories et lieux du catalogue (partie 4, R-CA-01, R-CA-05,
 * R-CA-06, R-CA-12, R-CA-14, R-FV-01). Jamais de suppression : `active: false` désactive. Un lieu
 * est créé inactif, puis activé une fois prêt ; le back-office lit les raisons de son masquage.
 */
export const trim = (value: string | undefined | null): string | null => {
  const text = (value ?? '').trim();
  return text.length ? text : null;
};

export interface PageInput {
  limit?: number | undefined;
  cursor?: string | undefined;
  sort?: string | undefined;
}

export interface CreateCategoryInput {
  idempotencyKey: string;
  code: string;
  name: string;
  icon?: string | undefined;
  order?: number | undefined;
  visitFee?: number | undefined;
}

export interface UpdateCategoryInput {
  id: string;
  name?: string | undefined;
  icon?: string | undefined;
  order?: number | undefined;
  visitFee?: number | undefined;
  active?: boolean | undefined;
}

export interface PlaceTypeInput {
  categoryId?: string | undefined;
  name?: string | undefined;
  icon?: string | undefined;
  photoFileId?: string | undefined;
  description?: string | undefined;
  order?: number | undefined;
  freeDescription?: boolean | undefined;
  /** Absent : inchangé (modification) ; présent : remplace la liste. */
  parameterIds?: string[] | undefined;
  areaParameterId?: string | undefined;
  active?: boolean | undefined;
}

/** Lieu vu du back-office, avec les raisons de son masquage (R-CA-12). */
export interface PlaceTypeView extends PlaceType {
  hiddenReasons: VisibilityReason[];
}

const CATEGORY_TRACED = ['code', 'order', 'active', 'visitFee'];
const PLACE_TYPE_TRACED = [
  'code',
  'categoryId',
  'order',
  'active',
  'isOther',
  'parameterIds',
  'areaParameterId',
  'photoFileId',
];

const byOrderThenName = <T extends { order: number; name: string }>(items: T[]) =>
  [...items].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'fr'));
const byName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((a, b) => a.name.localeCompare(b.name, 'fr'));

const categorySnapshot = (category: PlaceCategory) => ({
  code: category.code,
  name: category.name,
  icon: category.icon,
  order: category.order,
  active: category.active,
  visitFee: category.visitFee,
});

const placeTypeSnapshot = (placeType: PlaceType) => ({
  code: placeType.code,
  categoryId: placeType.categoryId,
  name: placeType.name,
  icon: placeType.icon,
  description: placeType.description,
  photoFileId: placeType.photoFileId,
  order: placeType.order,
  active: placeType.active,
  isOther: placeType.isOther,
  parameterIds: placeType.parameters.map((link) => link.parameterId),
  areaParameterId: placeType.areaParameterId,
});

export class PlaceCategoriesUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: PageInput): Promise<Page<PlaceCategory>> {
    requireStaff();
    const page = parsePage(input);
    const sort = parseSort(input.sort, ['order', 'name']);
    const categories = await this.deps.places.listCategories();
    return pageOf(sort === 'order' ? byOrderThenName(categories) : byName(categories), page);
  }

  async get(id: string): Promise<PlaceCategory> {
    requireStaff();
    const category = await this.deps.places.getCategory(id);
    if (!category) throw CleaningErrors.placeCategoryNotFound();
    return category;
  }

  async create(input: CreateCategoryInput): Promise<PlaceCategory> {
    const { userId } = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.category.create',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.get(String(response.id)),
      run: async (stub) => {
        const category: PlaceCategory = {
          id: this.deps.ids.next(),
          code: input.code,
          name: trim(input.name) ?? '',
          icon: trim(input.icon),
          order: input.order ?? 0,
          active: true,
          visitFee: input.visitFee ?? null,
          updatedAt: now,
          updatedBy: userId,
        };
        throwFirstProblem(categoryProblems(category));
        const audit = auditOf({
          actorId: userId,
          action: 'catalog.category.created',
          entityType: 'place_category',
          entityId: category.id,
          at: now,
          before: null,
          after: categorySnapshot(category),
          traced: CATEGORY_TRACED,
        });
        await this.saveOrConflict(category, 'create', {
          events: [],
          audit: [audit],
          idempotency: stub({ id: category.id }),
        });
        return category;
      },
    });
  }

  async update(input: UpdateCategoryInput): Promise<PlaceCategory> {
    const { userId } = requireStaff();
    const before = await this.deps.places.getCategory(input.id);
    if (!before) throw CleaningErrors.placeCategoryNotFound();
    const now = this.deps.clock.now();
    const after: PlaceCategory = {
      ...before,
      ...(input.name !== undefined ? { name: trim(input.name) ?? '' } : {}),
      ...(input.icon !== undefined ? { icon: trim(input.icon) } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(input.visitFee !== undefined ? { visitFee: input.visitFee } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      updatedAt: now,
      updatedBy: userId,
    };
    throwFirstProblem(categoryProblems(after));
    const audit = auditOf({
      actorId: userId,
      action: 'catalog.category.updated',
      entityType: 'place_category',
      entityId: after.id,
      at: now,
      before: categorySnapshot(before),
      after: categorySnapshot(after),
      traced: CATEGORY_TRACED,
    });
    await this.saveOrConflict(after, 'update', { events: [], audit: [audit] });
    return after;
  }

  private async saveOrConflict(
    category: PlaceCategory,
    mode: 'create' | 'update',
    changes: Parameters<CleaningDeps['places']['saveCategory']>[2],
  ): Promise<void> {
    try {
      await this.deps.places.saveCategory(category, mode, changes);
    } catch (error) {
      throw codeConflict(error, category.code);
    }
  }
}

/** Code déjà pris : CLEANING_CODE_ALREADY_USED ; écriture concurrente : CLEANING_CONCURRENT_UPDATE. */
export function codeConflict(error: unknown, code: string): unknown {
  if (!(error instanceof DuplicateKeyError)) return error;
  if (error.key === 'code') return CleaningErrors.codeAlreadyUsed(code);
  if (error.key === 'concurrent') return CleaningErrors.concurrentUpdate();
  return error;
}

export class PlaceTypesUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: PageInput & { categoryId?: string | undefined }): Promise<Page<PlaceTypeView>> {
    requireStaff();
    const page = parsePage(input);
    const sort = parseSort(input.sort, ['order', 'name']);
    const views = await this.views(await this.deps.places.listPlaceTypes());
    const filtered = views.filter((view) => !input.categoryId || view.categoryId === input.categoryId);
    return pageOf(sort === 'order' ? byOrderThenName(filtered) : byName(filtered), page);
  }

  async get(id: string): Promise<PlaceTypeView> {
    requireStaff();
    const placeType = await this.deps.places.getPlaceType(id);
    if (!placeType) throw CleaningErrors.placeTypeNotFound();
    return (await this.views([placeType]))[0] as PlaceTypeView;
  }

  async create(input: PlaceTypeInput & { idempotencyKey: string; code: string }): Promise<PlaceTypeView> {
    const { userId } = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.place_type.create',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.get(String(response.id)),
      run: async (stub) => {
        const blank: PlaceType = {
          id: this.deps.ids.next(),
          code: input.code,
          categoryId: '',
          name: '',
          icon: null,
          photoFileId: null,
          description: null,
          order: 0,
          active: false,
          isOther: false,
          parameters: [],
          areaParameterId: null,
          updatedAt: now,
          updatedBy: userId,
        };
        const placeType = await this.merge(
          blank,
          { ...input, parameterIds: input.parameterIds ?? [] },
          now,
          userId,
        );
        const audit = this.audit(userId, 'catalog.place_type.created', null, placeType, now);
        await this.save(placeType, 'create', {
          events: [],
          audit: [audit],
          idempotency: stub({ id: placeType.id }),
        });
        return this.get(placeType.id);
      },
    });
  }

  async update(input: PlaceTypeInput & { id: string }): Promise<PlaceTypeView> {
    const { userId } = requireStaff();
    const before = await this.deps.places.getPlaceType(input.id);
    if (!before) throw CleaningErrors.placeTypeNotFound();
    const now = this.deps.clock.now();
    const after = await this.merge(before, input, now, userId);
    await this.save(after, 'update', {
      events: [],
      audit: [this.audit(userId, 'catalog.place_type.updated', before, after, now)],
    });
    return this.get(after.id);
  }

  /** Applique les champs reçus, vérifie la catégorie et les paramètres cités, puis le lieu entier. */
  private async merge(base: PlaceType, input: PlaceTypeInput, now: Date, userId: string): Promise<PlaceType> {
    const categoryId = input.categoryId ?? base.categoryId;
    if (input.categoryId !== undefined || !base.categoryId) {
      if (!(await this.deps.places.getCategory(categoryId))) throw CleaningErrors.placeCategoryNotFound();
    }
    const parameterIds = input.parameterIds ?? base.parameters.map((link) => link.parameterId);
    const parameters = await resolveParameters(this.deps, parameterIds);
    const placeType: PlaceType = {
      ...base,
      categoryId,
      ...(input.name !== undefined ? { name: trim(input.name) ?? '' } : {}),
      ...(input.icon !== undefined ? { icon: trim(input.icon) } : {}),
      ...(input.photoFileId !== undefined ? { photoFileId: trim(input.photoFileId) } : {}),
      ...(input.description !== undefined ? { description: trim(input.description) } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
      ...(input.freeDescription !== undefined ? { isOther: input.freeDescription } : {}),
      ...(input.areaParameterId !== undefined ? { areaParameterId: trim(input.areaParameterId) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      parameters: parameters.map((parameter) => ({ parameterId: parameter.id, code: parameter.code })),
      updatedAt: now,
      updatedBy: userId,
    };
    throwFirstProblem(placeTypeProblems({ ...placeType, parameters }));
    return placeType;
  }

  private audit(userId: string, action: string, before: PlaceType | null, after: PlaceType, at: Date) {
    return auditOf({
      actorId: userId,
      action,
      entityType: 'place_type',
      entityId: after.id,
      at,
      before: before && placeTypeSnapshot(before),
      after: placeTypeSnapshot(after),
      traced: PLACE_TYPE_TRACED,
    });
  }

  private async save(
    placeType: PlaceType,
    mode: 'create' | 'update',
    changes: Parameters<CleaningDeps['places']['savePlaceType']>[2],
  ): Promise<void> {
    try {
      await this.deps.places.savePlaceType(placeType, mode, changes);
    } catch (error) {
      throw codeConflict(error, placeType.code);
    }
  }

  /** Raisons du masquage de chaque lieu, d'après sa catégorie, ses offres et leurs types. */
  private async views(placeTypes: PlaceType[]): Promise<PlaceTypeView[]> {
    const [categories, offers, types] = await Promise.all([
      this.deps.places.listCategories(),
      this.deps.offers.listOffers(),
      this.deps.cleaningTypes.listCleaningTypes(),
    ]);
    const activeCategory = new Map(categories.map((category) => [category.id, category.active]));
    const activeType = new Map(types.map((type) => [type.id, type.active]));
    return placeTypes.map((placeType) => ({
      ...placeType,
      hiddenReasons: placeTypeHiddenReasons({
        active: placeType.active,
        categoryActive: activeCategory.get(placeType.categoryId) ?? false,
        isOther: placeType.isOther,
        offers: offers
          .filter((offer) => offer.placeTypeId === placeType.id)
          .map((offer) => ({
            active: offer.active,
            typeActive: activeType.get(offer.cleaningTypeId) ?? false,
          })),
      }),
    }));
  }
}

/** Paramètres cités, dans l'ordre ; un identifiant inconnu : CLEANING_PARAMETER_NOT_FOUND. */
export async function resolveParameters(deps: CleaningDeps, ids: readonly string[]): Promise<Parameter[]> {
  const known = new Map(
    (await deps.parameters.listParameters()).map((parameter) => [parameter.id, parameter]),
  );
  return ids.map((id) => {
    const parameter = known.get(id);
    if (!parameter) throw CleaningErrors.parameterNotFound({ parameterId: id });
    return parameter;
  });
}
