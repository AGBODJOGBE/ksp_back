import { type CatalogSettings, type CatalogSettingsReader } from '../../../application/catalog/catalog.ports';
import { type IdempotencyRecord, type IdempotencyStore } from '../../../application/ports';
import { type PrismaService } from '../../prisma/prisma.service';

/** Réglages lus par le catalogue et le simulateur (partie 16.1) : ligne unique créée par la migration. */
export class PrismaCatalogSettingsReader implements CatalogSettingsReader {
  constructor(private readonly prisma: PrismaService) {}

  async catalogSettings(): Promise<CatalogSettings> {
    const row = await this.prisma.cleaningSettings.findUniqueOrThrow({
      where: { id: 1 },
      select: { defaultVisitFee: true, programMaxMonths: true, programMaxSessions: true },
    });
    return row;
  }
}

/** Clés d'idempotence consommées (règle d'or n° 3), écrites par writeChanges avec l'action. */
export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(ref: {
    actorId: string;
    operation: string;
    key: string;
  }): Promise<Pick<IdempotencyRecord, 'requestHash' | 'response'> | null> {
    const row = await this.prisma.idempotencyRecord.findUnique({
      where: {
        actorId_operation_idempotencyKey: {
          actorId: ref.actorId,
          operation: ref.operation,
          idempotencyKey: ref.key,
        },
      },
      select: { requestHash: true, response: true },
    });
    return row && { requestHash: row.requestHash, response: row.response as Record<string, unknown> };
  }
}
