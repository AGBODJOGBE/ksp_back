import { Injectable } from '@nestjs/common';
import { type ContractInvoiceRepository, type ContractInvoiceStatus } from '../../application/ports';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaContractInvoiceRepository implements ContractInvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Inbox et état de la facture dans la même transaction. Une facture « paid » n'est jamais
   * ramenée à « overdue » : l'ordre d'arrivée des événements est sans effet.
   */
  record(input: {
    eventId: string;
    consumer: string;
    invoiceId: string;
    missionId: string;
    status: ContractInvoiceStatus;
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
      await tx.$executeRawUnsafe(
        'INSERT INTO contract_invoices (invoice_id, mission_id, status, updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4) ' +
          'ON CONFLICT (invoice_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at ' +
          "WHERE contract_invoices.status <> 'paid'",
        input.invoiceId,
        input.missionId,
        input.status,
        input.at,
      );
      return 'processed';
    });
  }

  countOverdue(missionId: string): Promise<number> {
    return this.prisma.contractInvoice.count({ where: { missionId, status: 'overdue' } });
  }
}
