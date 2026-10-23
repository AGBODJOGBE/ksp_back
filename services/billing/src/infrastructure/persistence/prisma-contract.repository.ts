import { Injectable } from '@nestjs/common';
import { type ContractRepository } from '../../application/ports';
import { type BillingContract, contractPeriods } from '../../domain/contract';
import { PrismaService } from '../prisma/prisma.service';
import { contractColumns, toContract } from './mappers';

@Injectable()
export class PrismaContractRepository implements ContractRepository {
  constructor(private readonly prisma: PrismaService) {}

  apply(
    eventId: string,
    consumer: string,
    contractId: string,
    change: (current: BillingContract | null) => BillingContract | null,
  ): Promise<'processed' | 'duplicate'> {
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRawUnsafe(
        'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
          'ON CONFLICT DO NOTHING',
        eventId,
        consumer,
      );
      if (inserted === 0) return 'duplicate';
      // Verrou du contrat : un événement à la fois, et aucune facture émise pendant le changement.
      await tx.$queryRawUnsafe('SELECT id FROM billing_contracts WHERE id = $1::uuid FOR UPDATE', contractId);
      const row = await tx.billingContract.findUnique({ where: { id: contractId } });
      const next = change(row ? toContract(row) : null);
      if (next) {
        const columns = contractColumns(next);
        await tx.billingContract.upsert({
          where: { id: contractId },
          create: { id: contractId, createdAt: next.createdAt, ...columns },
          update: columns,
        });
      }
      return 'processed';
    });
  }

  async findById(id: string): Promise<BillingContract | null> {
    const row = await this.prisma.billingContract.findUnique({ where: { id } });
    return row ? toContract(row) : null;
  }

  async listOpen(): Promise<{ contract: BillingContract; invoicedIndexes: number[] }[]> {
    const rows = await this.prisma.billingContract.findMany({
      include: { invoices: { select: { periodIndex: true } } },
      orderBy: { id: 'asc' },
    });
    return rows
      .map(({ invoices, ...row }) => ({
        contract: toContract(row),
        invoicedIndexes: invoices.map((invoice) => invoice.periodIndex),
      }))
      .filter(({ contract, invoicedIndexes }) => invoicedIndexes.length < contractPeriods(contract).length);
  }
}
