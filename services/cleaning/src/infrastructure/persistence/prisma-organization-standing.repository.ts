import { Injectable } from '@nestjs/common';
import { type OrganizationStandingRepository } from '../../application/ports';
import { PrismaService } from '../prisma/prisma.service';
import { type Tx } from './changes';

/**
 * Verrou transactionnel de l'état d'une organisation, puis son état (true : suspendue). Pris par
 * l'enregistrement d'un événement d'identity et par l'acceptation d'un devis : une mission ne peut
 * pas être créée entre l'enregistrement d'une suspension et l'alignement des missions qui le suit.
 */
export async function lockOrganizationStanding(tx: Tx, organizationId: string): Promise<boolean> {
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext('organization_standings'), hashtext($1))",
    organizationId,
  );
  const row = await tx.organizationStanding.findUnique({
    where: { organizationId },
    select: { suspended: true },
  });
  return row?.suspended ?? false;
}

@Injectable()
export class PrismaOrganizationStandingRepository implements OrganizationStandingRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inbox et état de l'organisation dans la même transaction. L'état n'est remplacé que par une
   * décision plus récente : l'ordre d'arrivée des événements est sans effet. Deux décisions de
   * même date : la suspension l'emporte (départage déterministe, ADR-030).
   */
  record(input: {
    eventId: string;
    consumer: string;
    organizationId: string;
    suspended: boolean;
    at: Date;
  }): Promise<'processed' | 'duplicate'> {
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRawUnsafe(
        'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
          'ON CONFLICT DO NOTHING',
        input.eventId,
        input.consumer,
      );
      if (inserted === 0) return 'duplicate';
      await lockOrganizationStanding(tx, input.organizationId);
      await tx.$executeRawUnsafe(
        'INSERT INTO organization_standings (organization_id, suspended, changed_at, updated_at) ' +
          'VALUES ($1::uuid, $2, $3, now()) ' +
          'ON CONFLICT (organization_id) DO UPDATE SET suspended = EXCLUDED.suspended, ' +
          'changed_at = EXCLUDED.changed_at, updated_at = EXCLUDED.updated_at ' +
          'WHERE organization_standings.changed_at < EXCLUDED.changed_at ' +
          'OR (organization_standings.changed_at = EXCLUDED.changed_at AND EXCLUDED.suspended ' +
          'AND NOT organization_standings.suspended)',
        input.organizationId,
        input.suspended,
        input.at,
      );
      return 'processed';
    });
  }

  async isSuspended(organizationId: string): Promise<boolean> {
    const row = await this.prisma.organizationStanding.findUnique({
      where: { organizationId },
      select: { suspended: true },
    });
    return row?.suspended ?? false;
  }
}
