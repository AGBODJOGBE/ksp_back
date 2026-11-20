import { type Prisma } from '../../../../prisma/generated';
import { ConcurrentUpdateError } from '../../../application/agents/agent.ports';
import { type Changes, type IdGenerator } from '../../../application/ports';
import {
  type DeclaredValues,
  type Owner,
  type PlaceRecord,
  type PlaceRepository,
} from '../../../application/requests/requests.ports';
import { type PrismaService } from '../../prisma/prisma.service';
import { isUuid } from '../agents/agent-rows';
import { json, translateUniqueViolation, writeChanges } from '../changes';

type PlaceRow = Prisma.PlaceGetPayload<object>;

function placeOf(row: PlaceRow): PlaceRecord {
  return {
    id: row.id,
    owner: { kind: row.ownerKind, id: row.ownerId },
    placeTypeId: row.placeTypeId,
    name: row.name,
    gpsEncrypted: row.gpsEncrypted,
    landmarkEncrypted: row.landmarkEncrypted,
    addressEncrypted: row.addressEncrypted,
    readableAddressEncrypted: row.readableAddressEncrypted,
    communeKey: row.communeKey,
    communeBoundariesVersion: row.communeBoundariesVersion,
    declaredValues: row.declaredValues as DeclaredValues,
    locationErasedAt: row.locationErasedAt,
    locationCorrectedAt: row.locationCorrectedAt,
    locationCorrectedBy: row.locationCorrectedBy,
    archivedAt: row.archivedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** Colonnes modifiables d'un lieu (position déjà chiffrée par l'application). */
export function placeData(place: PlaceRecord) {
  return {
    placeTypeId: place.placeTypeId,
    name: place.name,
    gpsEncrypted: place.gpsEncrypted,
    landmarkEncrypted: place.landmarkEncrypted,
    addressEncrypted: place.addressEncrypted,
    readableAddressEncrypted: place.readableAddressEncrypted,
    communeKey: place.communeKey,
    communeBoundariesVersion: place.communeBoundariesVersion,
    declaredValues: json(place.declaredValues),
    locationErasedAt: place.locationErasedAt,
    locationCorrectedAt: place.locationCorrectedAt,
    locationCorrectedBy: place.locationCorrectedBy,
    archivedAt: place.archivedAt,
    updatedAt: place.updatedAt,
  };
}

/** « Mes lieux » (partie 3) : lieux d'un titulaire, verrou optimiste par version. */
export class PrismaClientPlacesRepository implements PlaceRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ids: IdGenerator,
  ) {}

  async findPlace(id: string): Promise<PlaceRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.place.findUnique({ where: { id } });
    return row ? placeOf(row) : null;
  }

  async listPlaces(
    owner: Owner,
    filter: { archived: boolean; sort: 'name' | '-createdAt' },
  ): Promise<PlaceRecord[]> {
    const rows = await this.prisma.place.findMany({
      where: { ownerKind: owner.kind, ownerId: owner.id, ...(filter.archived ? {} : { archivedAt: null }) },
      orderBy:
        filter.sort === 'name' ? [{ name: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(placeOf);
  }

  async insertPlace(place: PlaceRecord, changes: Changes): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await writeChanges(tx, changes, () => this.ids.next());
        await tx.place.create({
          data: {
            id: place.id,
            ownerKind: place.owner.kind,
            ownerId: place.owner.id,
            ...placeData(place),
            createdBy: place.createdBy,
            createdAt: place.createdAt,
          },
        });
      });
    } catch (error) {
      throw translateUniqueViolation(error);
    }
  }

  async updatePlace(place: PlaceRecord, expectedVersion: number, changes: Changes): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await writeChanges(tx, changes, () => this.ids.next());
      const { count } = await tx.place.updateMany({
        where: { id: place.id, version: expectedVersion },
        data: { ...placeData(place), version: { increment: 1 } },
      });
      if (count !== 1) throw new ConcurrentUpdateError();
    });
  }
}
