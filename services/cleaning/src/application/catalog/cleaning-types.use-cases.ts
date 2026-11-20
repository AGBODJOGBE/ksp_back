import { AppError } from '@ksp/platform';
import { type ChecklistItemEntry, cleaningTypeProblems } from '../../domain/catalog/entries';
import { packCompositionProblems } from '../../domain/pricing/pack';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { CleaningErrors, throwFirstProblem } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { type Page, pageOf, parsePage, parseSort } from '../shared/paging';
import { auditOf } from './audit';
import { type CleaningType } from './catalog.ports';
import { codeConflict, type PageInput, trim } from './places.use-cases';

/**
 * UC-NT-26 — Gérer les types de nettoyage, les packs et les listes de contrôle (R-CA-04, R-CA-06,
 * R-CA-09). Un type simple exige une compétence connue ; un pack n'en porte pas et contient des types
 * simples seulement (décision du responsable : jamais un pack dans un pack). Un type contenu inconnu
 * répond CLEANING_TYPE_NOT_FOUND.
 */
export interface CleaningTypeFields {
  name?: string | undefined;
  description?: string | undefined;
  icon?: string | undefined;
  requiredSkillCode?: string | undefined;
  referenceDurationMinutes?: number | undefined;
  /** Absent : inchangé (modification) ; présent : remplace la liste. */
  checklist?: ChecklistItemEntry[] | undefined;
  isPack?: boolean | undefined;
  /** Absent : inchangé (modification) ; présent : remplace la liste. */
  packItemIds?: string[] | undefined;
}

const TRACED = [
  'code',
  'requiredSkillCode',
  'referenceDurationMinutes',
  'isPack',
  'packItemIds',
  'active',
  'checklistCodes',
];

const snapshot = (type: CleaningType) => ({
  code: type.code,
  name: type.name,
  description: type.description,
  icon: type.icon,
  requiredSkillCode: type.requiredSkillCode,
  referenceDurationMinutes: type.referenceDurationMinutes,
  isPack: type.isPack,
  packItemIds: type.packItemIds,
  active: type.active,
  checklistCodes: type.checklist.map((item) => item.code),
  checklistLabels: type.checklist.map((item) => item.label),
});

export class CleaningTypesUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async list(input: PageInput): Promise<Page<CleaningType>> {
    requireStaff();
    const page = parsePage(input);
    parseSort(input.sort, ['name']);
    const types = await this.deps.cleaningTypes.listCleaningTypes();
    return pageOf(
      types.sort((a, b) => a.name.localeCompare(b.name, 'fr')),
      page,
    );
  }

  async get(id: string): Promise<CleaningType> {
    requireStaff();
    const type = await this.deps.cleaningTypes.getCleaningType(id);
    if (!type) throw CleaningErrors.cleaningTypeNotFound();
    return type;
  }

  async create(input: CleaningTypeFields & { idempotencyKey: string; code: string }): Promise<CleaningType> {
    const { userId } = requireStaff();
    const now = this.deps.clock.now();
    const { idempotencyKey, ...body } = input;
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: userId,
      operation: 'catalog.cleaning_type.create',
      key: idempotencyKey,
      body,
      at: now,
      replay: (response) => this.get(String(response.id)),
      run: async (stub) => {
        const blank: CleaningType = {
          id: this.deps.ids.next(),
          code: input.code,
          name: '',
          description: null,
          icon: null,
          requiredSkillCode: null,
          referenceDurationMinutes: 0,
          checklist: [],
          isPack: false,
          packItemIds: [],
          active: true,
          updatedAt: now,
          updatedBy: userId,
        };
        const type = await this.merge(blank, input, now, userId);
        const audit = this.audit(userId, 'catalog.cleaning_type.created', null, type, now);
        try {
          await this.deps.cleaningTypes.saveCleaningType(type, 'create', {
            events: [],
            audit: [audit],
            idempotency: stub({ id: type.id }),
          });
        } catch (error) {
          throw codeConflict(error, type.code);
        }
        return type;
      },
    });
  }

  async update(
    input: CleaningTypeFields & { id: string; active?: boolean | undefined },
  ): Promise<CleaningType> {
    const { userId } = requireStaff();
    const before = await this.deps.cleaningTypes.getCleaningType(input.id);
    if (!before) throw CleaningErrors.cleaningTypeNotFound();
    const now = this.deps.clock.now();
    const merged = await this.merge(before, input, now, userId);
    const after = input.active === undefined ? merged : { ...merged, active: input.active };
    await this.deps.cleaningTypes.saveCleaningType(after, 'update', {
      events: [],
      audit: [this.audit(userId, 'catalog.cleaning_type.updated', before, after, now)],
    });
    return after;
  }

  /** Champs reçus appliqués, puis le type entier contrôlé : bornes, compétence, composition du pack. */
  private async merge(
    base: CleaningType,
    input: CleaningTypeFields,
    now: Date,
    userId: string,
  ): Promise<CleaningType> {
    const isPack = input.isPack ?? base.isPack;
    const type: CleaningType = {
      ...base,
      ...(input.name !== undefined ? { name: trim(input.name) ?? '' } : {}),
      ...(input.description !== undefined ? { description: trim(input.description) } : {}),
      ...(input.icon !== undefined ? { icon: trim(input.icon) } : {}),
      ...(input.referenceDurationMinutes !== undefined
        ? { referenceDurationMinutes: input.referenceDurationMinutes }
        : {}),
      ...(input.checklist !== undefined
        ? { checklist: input.checklist.map((item) => ({ ...item, label: trim(item.label) ?? '' })) }
        : {}),
      isPack,
      requiredSkillCode:
        input.requiredSkillCode !== undefined
          ? trim(input.requiredSkillCode)
          : isPack
            ? null
            : base.requiredSkillCode,
      packItemIds: input.packItemIds ?? (isPack ? base.packItemIds : []),
      updatedAt: now,
      updatedBy: userId,
    };
    throwFirstProblem(cleaningTypeProblems(type));
    if (type.requiredSkillCode !== null) {
      const skills = await this.deps.cleaningTypes.listSkills();
      if (!skills.some((skill) => skill.code === type.requiredSkillCode)) {
        throw CleaningErrors.skillNotFound(type.requiredSkillCode);
      }
    }
    const all = new Map(
      (await this.deps.cleaningTypes.listCleaningTypes()).map((other) => [other.id, other]),
    );
    const items = type.packItemIds.map((id) => {
      const item = all.get(id);
      if (!item) {
        throw AppError.notFound('CLEANING_TYPE_NOT_FOUND', 'Ce type de nettoyage est introuvable.', {
          cleaningTypeId: id,
        });
      }
      return { id, isPack: item.isPack };
    });
    const containedInPack = [...all.values()].some(
      (other) => other.id !== type.id && other.packItemIds.includes(type.id),
    );
    throwFirstProblem(packCompositionProblems({ typeId: type.id, isPack, items, containedInPack }));
    return type;
  }

  private audit(userId: string, action: string, before: CleaningType | null, after: CleaningType, at: Date) {
    return auditOf({
      actorId: userId,
      action,
      entityType: 'cleaning_type',
      entityId: after.id,
      at,
      before: before && snapshot(before),
      after: snapshot(after),
      traced: TRACED,
    });
  }
}
