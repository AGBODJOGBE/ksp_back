import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import { type PageRequest } from '../../application/cases/ports';
import { type Holder } from '../../application/ports';
import {
  type CommissionInvoiceRecord,
  type StatementFilter,
  type StatementRecord,
  type StatementStore,
} from '../../application/statements/statements.ports';
import { PrismaService } from '../prisma/prisma.service';

type StatementRow = Prisma.StatementGetPayload<{ include: { case: { select: { number: true } } } }>;

function statementOf(row: StatementRow): StatementRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    caseNumber: row.case.number,
    creditor: { type: row.creditorType, id: row.creditorId },
    period: row.period,
    collected: row.collected,
    commission: row.commission,
    costs: row.costs,
    remitted: row.remitted,
    documentId: row.documentId,
    documentNumber: row.documentNumber,
    invoiceId: row.invoiceId,
    issuedAt: row.issuedAt,
  };
}

/**
 * Relevés mensuels (R-CO-05) et factures de commission de billing (ADR-064) dans la base du service :
 * un relevé par dossier et par mois (index unique), une facture par créancier et par mois ; la facture
 * est rattachée aux relevés de son créancier et de son mois, qu'elle arrive avant ou après eux. Les
 * encaissements (lot R3) ne sont que lus.
 */
@Injectable()
export class PrismaStatementStore implements StatementStore {
  constructor(private readonly prisma: PrismaService) {}

  async casesToState(
    period: string,
    bounds: { start: Date; end: Date },
    afterId: string | null,
    limit: number,
  ): Promise<string[]> {
    const after = afterId ? Prisma.sql`AND c.case_id > ${afterId}::uuid` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT c.case_id::text AS id FROM collections c
      WHERE c.commission_settlement = 'deducted' AND c.gross > c.overpaid
        AND c.credited_at >= ${bounds.start} AND c.credited_at < ${bounds.end} ${after}
        AND NOT EXISTS (SELECT 1 FROM statements s WHERE s.case_id = c.case_id AND s.period = ${period})
      ORDER BY id LIMIT ${limit}`;
    return rows.map((row) => row.id);
  }

  async insert(statement: StatementRecord): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.statement.createMany({
        data: [
          {
            id: statement.id,
            caseId: statement.caseId,
            creditorType: statement.creditor.type,
            creditorId: statement.creditor.id,
            period: statement.period,
            collected: statement.collected,
            commission: statement.commission,
            costs: statement.costs,
            remitted: statement.remitted,
            documentId: statement.documentId,
            documentNumber: statement.documentNumber,
            invoiceId: statement.invoiceId,
            issuedAt: statement.issuedAt,
          },
        ],
        // Relevé de ce dossier et de ce mois déjà enregistré par une autre instance de la tâche.
        skipDuplicates: true,
      });
      if (count === 0) return false;
      await tx.$executeRaw`
        UPDATE statements s SET invoice_id = i.id FROM commission_invoices i
        WHERE s.id = ${statement.id}::uuid AND s.invoice_id IS NULL AND i.creditor_type = s.creditor_type
          AND i.creditor_id = s.creditor_id AND i.period = s.period`;
      return true;
    });
  }

  async recordInvoice(
    invoice: CommissionInvoiceRecord,
    inbox: { eventId: string; consumer: string },
  ): Promise<{ outcome: 'recorded' | 'duplicate'; statements: number }> {
    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRawUnsafe(
        'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
          'ON CONFLICT DO NOTHING',
        inbox.eventId,
        inbox.consumer,
      );
      if (inserted === 0) return { outcome: 'duplicate' as const, statements: 0 };
      // Une facture par créancier et par mois : la première reçue fait foi.
      await tx.commissionInvoice.createMany({
        data: [
          {
            id: invoice.id,
            number: invoice.number,
            creditorType: invoice.creditor.type,
            creditorId: invoice.creditor.id,
            period: invoice.period,
            issuedAt: invoice.issuedAt,
          },
        ],
        skipDuplicates: true,
      });
      const statements = await tx.$executeRaw`
        UPDATE statements s SET invoice_id = i.id FROM commission_invoices i
        WHERE s.invoice_id IS NULL AND s.creditor_type = ${invoice.creditor.type}::"PartyType"
          AND s.creditor_id = ${invoice.creditor.id}::uuid AND s.period = ${invoice.period}
          AND i.creditor_type = s.creditor_type AND i.creditor_id = s.creditor_id AND i.period = s.period`;
      return { outcome: 'recorded' as const, statements };
    });
  }

  async list(
    creditor: Holder,
    filter: StatementFilter,
    page: PageRequest,
  ): Promise<{ items: StatementRecord[]; nextCursor: string | null }> {
    const rows = await this.prisma.statement.findMany({
      where: {
        creditorType: creditor.type,
        creditorId: creditor.id,
        ...(filter.period ? { period: filter.period } : {}),
        ...(filter.caseId ? { caseId: filter.caseId } : {}),
      },
      include: { case: { select: { number: true } } },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
      ...(page.cursor ? { cursor: { id: page.cursor }, skip: 1 } : {}),
    });
    const more = rows.length > page.limit;
    const kept = more ? rows.slice(0, page.limit) : rows;
    return { items: kept.map(statementOf), nextCursor: more ? kept[kept.length - 1]!.id : null };
  }
}
