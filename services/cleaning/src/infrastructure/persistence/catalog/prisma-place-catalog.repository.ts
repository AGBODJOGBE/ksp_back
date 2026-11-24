import { type Prisma } from '../../../../prisma/generated';
import {
  type PlaceCatalogRepository,
  type PlaceCategory,
  type PlaceType,
  type SaveMode,
} from '../../../application/catalog/catalog.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid, optional, transact } from './shared';

const placeTypeInclude = {
  parameters: { orderBy: { position: 'asc' }, include: { parameter: { select: { code: true } } } },
} as const;

type CategoryRow = Prisma.PlaceCategoryGetPayload<object>;
type PlaceTypeRow = Prisma.PlaceTypeGetPayload<{ include: typeof placeTypeInclude }>;

const toCategory = (row: CategoryRow): PlaceCategory => ({
  id: row.id,
  code: row.code,
  name: row.name,
  icon: optional(row.icon),
  order: row.displayOrder,
  active: row.active,
  visitFee: row.visitFee,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

const toPlaceType = (row: PlaceTypeRow): PlaceType => ({
  id: row.id,
  code: row.code,
  categoryId: row.categoryId,
  name: row.name,
  icon: optional(row.icon),
  photoFileId: row.photoFileId,
  description: optional(row.description),
  order: row.displayOrder,
  active: row.active,
  isOther: row.isOther,
  parameters: row.parameters.map((link) => ({ parameterId: link.parameterId, code: link.parameter.code })),
  areaParameterId: row.areaParameterId,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

/** Catégories et lieux du catalogue (partie 4), jamais supprimés (R-CA-06). */
export class PrismaPlaceCatalogRepository implements PlaceCatalogRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async listCategories(): Promise<PlaceCategory[]> {
    return (await this.prisma.placeCategory.findMany()).map(toCategory);
  }

  async getCategory(id: string): Promise<PlaceCategory | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.placeCategory.findUnique({ where: { id } });
    return row && toCategory(row);
  }

  async saveCategory(category: PlaceCategory, mode: SaveMode, changes: Changes): Promise<void> {
    const data = {
      name: category.name,
      icon: category.icon ?? '',
      displayOrder: category.order,
      visitFee: category.visitFee,
      active: category.active,
      updatedAt: category.updatedAt,
      updatedBy: category.updatedBy,
    };
    await this.write(changes, (tx) =>
      mode === 'create'
        ? tx.placeCategory.create({
            data: { ...data, id: category.id, code: category.code, createdAt: category.updatedAt },
          })
        : tx.placeCategory.update({ where: { id: category.id }, data }),
    );
  }

  async listPlaceTypes(): Promise<PlaceType[]> {
    return (await this.prisma.placeType.findMany({ include: placeTypeInclude })).map(toPlaceType);
  }

  async getPlaceType(id: string): Promise<PlaceType | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.placeType.findUnique({ where: { id }, include: placeTypeInclude });
    return row && toPlaceType(row);
  }

  /** Paramètres du lieu remplacés en entier, dans l'ordre donné (R-CA-01). */
  async savePlaceType(placeType: PlaceType, mode: SaveMode, changes: Changes): Promise<void> {
    const data = {
      categoryId: placeType.categoryId,
      name: placeType.name,
      description: placeType.description ?? '',
      icon: placeType.icon ?? '',
      photoFileId: placeType.photoFileId,
      displayOrder: placeType.order,
      isOther: placeType.isOther,
      areaParameterId: placeType.areaParameterId,
      active: placeType.active,
      updatedAt: placeType.updatedAt,
      updatedBy: placeType.updatedBy,
    };
    await this.write(changes, async (tx) => {
      if (mode === 'create') {
        await tx.placeType.create({
          data: { ...data, id: placeType.id, code: placeType.code, createdAt: placeType.updatedAt },
        });
      } else {
        await tx.placeType.update({ where: { id: placeType.id }, data });
        await tx.placeTypeParameter.deleteMany({ where: { placeTypeId: placeType.id } });
      }
      await tx.placeTypeParameter.createMany({
        data: placeType.parameters.map((link, position) => ({
          placeTypeId: placeType.id,
          parameterId: link.parameterId,
          position,
        })),
      });
    });
  }

  private write(changes: Changes, apply: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
    return transact(this.prisma, this.ids, changes, apply);
  }
}
