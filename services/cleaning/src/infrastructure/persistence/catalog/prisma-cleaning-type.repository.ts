import { type Prisma } from '../../../../prisma/generated';
import {
  type CleaningType,
  type CleaningTypeRepository,
  type SaveMode,
  type Skill,
} from '../../../application/catalog/catalog.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import { type ChecklistItemEntry } from '../../../domain/catalog/entries';
import { type PrismaService } from '../../prisma/prisma.service';
import { json } from '../changes';
import { isUuid, optional, transact } from './shared';

const include = { packItems: { select: { itemId: true }, orderBy: { itemId: 'asc' } } } as const;
type CleaningTypeRow = Prisma.CleaningTypeGetPayload<{ include: typeof include }>;

const toCleaningType = (row: CleaningTypeRow): CleaningType => ({
  id: row.id,
  code: row.code,
  name: row.name,
  description: optional(row.description),
  icon: optional(row.icon),
  requiredSkillCode: row.requiredSkillCode,
  referenceDurationMinutes: row.referenceDurationMinutes,
  checklist: (row.checklistTemplate as unknown as ChecklistItemEntry[]).map((item) => ({
    code: item.code,
    label: item.label,
    order: item.order,
  })),
  isPack: row.isPack,
  packItemIds: row.packItems.map((item) => item.itemId),
  active: row.active,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

const toSkill = (row: Prisma.SkillGetPayload<object>): Skill => ({
  id: row.id,
  code: row.code,
  name: row.name,
  active: row.active,
});

/**
 * Types de nettoyage, packs et compétences (R-CA-04, R-CA-09). Les types d'un pack sont rendus par
 * identifiant croissant : la table de liaison ne garde pas d'ordre.
 */
export class PrismaCleaningTypeRepository implements CleaningTypeRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async listCleaningTypes(): Promise<CleaningType[]> {
    return (await this.prisma.cleaningType.findMany({ include })).map(toCleaningType);
  }

  async getCleaningType(id: string): Promise<CleaningType | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.cleaningType.findUnique({ where: { id }, include });
    return row && toCleaningType(row);
  }

  async saveCleaningType(type: CleaningType, mode: SaveMode, changes: Changes): Promise<void> {
    const data = {
      name: type.name,
      description: type.description ?? '',
      icon: type.icon ?? '',
      requiredSkillCode: type.requiredSkillCode,
      referenceDurationMinutes: type.referenceDurationMinutes,
      checklistTemplate: json(type.checklist),
      isPack: type.isPack,
      active: type.active,
      updatedAt: type.updatedAt,
      updatedBy: type.updatedBy,
    };
    await transact(this.prisma, this.ids, changes, async (tx) => {
      if (mode === 'create') {
        await tx.cleaningType.create({
          data: { ...data, id: type.id, code: type.code, createdAt: type.updatedAt },
        });
      } else {
        await tx.cleaningType.update({ where: { id: type.id }, data });
        await tx.packItem.deleteMany({ where: { packId: type.id } });
      }
      await tx.packItem.createMany({ data: type.packItemIds.map((itemId) => ({ packId: type.id, itemId })) });
    });
  }

  async listSkills(): Promise<Skill[]> {
    return (await this.prisma.skill.findMany()).map(toSkill);
  }

  async getSkill(id: string): Promise<Skill | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.skill.findUnique({ where: { id } });
    return row && toSkill(row);
  }

  async saveSkill(skill: Skill, mode: SaveMode, at: Date, changes: Changes): Promise<void> {
    await transact(this.prisma, this.ids, changes, (tx) =>
      mode === 'create'
        ? tx.skill.create({ data: { ...skill, createdAt: at, updatedAt: at } })
        : tx.skill.update({
            where: { id: skill.id },
            data: { name: skill.name, active: skill.active, updatedAt: at },
          }),
    );
  }
}
