import { Injectable } from '@nestjs/common';
import {
  type InvoiceFilter,
  type InvoiceRepository,
  type OutboxMessage,
  type PageRequest,
  type PageResult,
} from '../../application/ports';
import { formatInvoiceNumber, type Invoice, type InvoicePayment } from '../../domain/invoice';
import { PrismaService } from '../prisma/prisma.service';
import { INVOICE_INCLUDE, json, pageArgs, toInvoice, toPage, type Tx, writeEvents } from './mappers';

@Injectable()
export class PrismaInvoiceRepository implements InvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}

  issue(
    draft: Omit<Invoice, 'number'>,
    events: (invoice: Invoice) => OutboxMessage[],
  ): Promise<Invoice | null> {
    return this.prisma.$transaction(async (tx) => {
      // Verrou du contrat : deux émissions simultanées du même mois sont sérialisées.
      await tx.$queryRawUnsafe(
        'SELECT id FROM billing_contracts WHERE id = $1::uuid FOR UPDATE',
        draft.contractId,
      );
      const existing = await tx.invoice.findUnique({
        where: { contractId_periodIndex: { contractId: draft.contractId, periodIndex: draft.periodIndex } },
        select: { id: true },
      });
      if (existing) return null;
      // Numéro tiré dans la même transaction : un échec ne laisse pas de trou.
      const year = draft.issuedAt.getUTCFullYear();
      const [counter] = await tx.$queryRawUnsafe<{ last_number: number }[]>(
        'INSERT INTO invoice_counters (year, last_number) VALUES ($1, 1) ' +
          'ON CONFLICT (year) DO UPDATE SET last_number = invoice_counters.last_number + 1 ' +
          'RETURNING last_number',
        year,
      );
      const invoice: Invoice = { ...draft, number: formatInvoiceNumber(year, Number(counter!.last_number)) };
      await tx.invoice.create({
        data: {
          id: invoice.id,
          number: invoice.number,
          status: invoice.status,
          contractId: invoice.contractId,
          customerId: invoice.customerId,
          organizationId: invoice.organizationId,
          source: invoice.source,
          periodIndex: invoice.periodIndex,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          lines: json(invoice.lines),
          total: invoice.total,
          issuedAt: invoice.issuedAt,
          dueAt: invoice.dueAt,
        },
      });
      await writeEvents(tx, events(invoice));
      return invoice;
    });
  }

  async findById(id: string): Promise<Invoice | null> {
    const row = await this.prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
    return row ? toInvoice(row) : null;
  }

  async list(filter: InvoiceFilter, page: PageRequest): Promise<PageResult<Invoice>> {
    const { where: cursor, ...args } = pageArgs(page);
    const rows = await this.prisma.invoice.findMany({
      where: {
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.organizationId !== undefined ? { organizationId: filter.organizationId } : {}),
        ...(filter.contractId ? { contractId: filter.contractId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...cursor,
      },
      include: INVOICE_INCLUDE,
      ...args,
    });
    const result = toPage(rows, page.limit);
    return { items: result.items.map(toInvoice), nextCursor: result.nextCursor };
  }

  async listPastDue(now: Date): Promise<Invoice[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { status: 'pending_payment', dueAt: { lte: now } },
      include: INVOICE_INCLUDE,
      orderBy: { dueAt: 'asc' },
    });
    return rows.map(toInvoice);
  }

  markOverdue(invoice: Invoice, events: (overdueCount: number) => OutboxMessage[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id: invoice.id, status: 'pending_payment', version: invoice.version },
        data: { status: 'overdue', version: { increment: 1 } },
      });
      if (count === 0) return false;
      await writeEvents(tx, events(await this.countOverdue(tx, invoice.contractId)));
      return true;
    });
  }

  recordPayment(
    invoice: Invoice,
    payment: InvoicePayment,
    events: (overdueCount: number) => OutboxMessage[],
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id: invoice.id, version: invoice.version },
        data: { status: invoice.status, paidAt: invoice.paidAt, version: { increment: 1 } },
      });
      if (count === 0) return false;
      await tx.invoicePayment.create({ data: { ...payment, invoiceId: invoice.id } });
      await writeEvents(tx, events(await this.countOverdue(tx, invoice.contractId)));
      return true;
    });
  }

  private countOverdue(tx: Tx, contractId: string): Promise<number> {
    return tx.invoice.count({ where: { contractId, status: 'overdue' } });
  }
}
