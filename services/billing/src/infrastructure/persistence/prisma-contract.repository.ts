import { Injectable } from '@nestjs/common';
import { type ContractRepository } from '../../application/ports';
import { type BillingContract, contractPeriods } from '../../domain/contract';
import { PrismaService } from '../prisma/prisma.service';
import { toContract } from './mappers';

@Injectable()
export class PrismaContractRepository implements ContractRepository {
  constructor(private readonly prisma: PrismaService) {}

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
        invoicedIndexes: invoices
          .map((invoice) => invoice.periodIndex)
          .filter((index): index is number => index !== null),
      }))
      .filter(({ contract, invoicedIndexes }) => invoicedIndexes.length < contractPeriods(contract).length);
  }
}
