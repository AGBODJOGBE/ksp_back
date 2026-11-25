import { Injectable } from '@nestjs/common';
import { type OutboxMessage, type PageRequest, type PageResult } from '../../application/ports';
import {
  type CommissionInvoiceFilter,
  type FeeReceiptFilter,
  type RecoveryBillingRepository,
} from '../../application/recovery/ports';
import {
  type CommissionCollection,
  type CommissionInvoice,
  commissionInvoiceYear,
  type CreditorRef,
  type CreditorType,
  formatCommissionInvoiceNumber,
} from '../../domain/commission-invoice';
import { type FeeReceipt, formatFeeReceiptNumber } from '../../domain/fee-receipt';
import { type BillingMonth } from '../../domain/monthly-invoice';
import { PrismaService } from '../prisma/prisma.service';
import { pageArgs, toPage, type Tx, writeEvents } from './mappers';
import {
  COMMISSION_INVOICE_INCLUDE,
  commissionSettlementColumns,
  nextNumber,
  toCommissionCollection,
  toCommissionInvoice,
  toFeeReceipt,
} from './recovery-mappers';

/**
 * Dépôt de la facturation du recouvrement (ADR-064). Chaque écriture et ses événements partent dans
 * la même transaction (outbox) ; l'émission d'une facture de commission est sérialisée par un verrou
 * consultatif du créancier, et l'index unique (créancier, mois) le garantit en base ; un reçu est
 * sérialisé par un verrou de la transaction du portefeuille, et unique par elle en base. Les numéros
 * sont tirés du compteur de leur série dans la transaction : un rejet n'en consomme aucun.
 */
@Injectable()
export class PrismaRecoveryBillingRepository implements RecoveryBillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  recordCollection(
    collection: CommissionCollection,
    inbox: { eventId: string; consumer: string },
  ): Promise<'recorded' | 'duplicate'> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await markProcessed(tx, inbox))) return 'duplicate' as const;
      const { count } = await tx.commissionCollection.createMany({
        data: [
          {
            collectionId: collection.collectionId,
            creditorType: collection.creditor.type,
            creditorId: collection.creditor.id,
            caseId: collection.caseId,
            caseNumber: collection.caseNumber,
            source: collection.source,
            gross: collection.gross,
            commission: collection.commission,
            settlement: collection.settlement,
            receivedAt: collection.receivedAt,
            invoiceId: null,
            recordedAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      return count === 0 ? ('duplicate' as const) : ('recorded' as const);
    });
  }

  async listCreditorsToInvoice(month: BillingMonth, limit: number): Promise<CreditorRef[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ creditor_type: string; creditor_id: string }[]>(
      'SELECT DISTINCT c.creditor_type, c.creditor_id::text AS creditor_id FROM commission_collections c ' +
        'WHERE c.invoice_id IS NULL AND c.received_at < $1 ' +
        'AND NOT EXISTS (SELECT 1 FROM commission_invoices i WHERE i.creditor_type = c.creditor_type ' +
        'AND i.creditor_id = c.creditor_id AND i.period_start = $2) ' +
        'ORDER BY 1, 2 LIMIT $3',
      month.end,
      month.start,
      limit,
    );
    return rows.map((row) => ({ type: row.creditor_type as CreditorType, id: row.creditor_id }));
  }

  issueCommissionInvoice(
    creditor: CreditorRef,
    month: BillingMonth,
    draft: (collections: CommissionCollection[]) => Omit<CommissionInvoice, 'number'> | null,
    events: (invoice: CommissionInvoice) => OutboxMessage[],
  ): Promise<CommissionInvoice | null> {
    const party = { creditorType: creditor.type, creditorId: creditor.id };
    return this.prisma.$transaction(async (tx) => {
      // Verrou du créancier : deux émissions simultanées du même mois sont sérialisées.
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext('billing.commission_invoice:' || $1::text || ':' || $2::text))",
        creditor.type,
        creditor.id,
      );
      const existing = await tx.commissionInvoice.findFirst({
        where: { ...party, periodStart: month.start },
        select: { id: true },
      });
      if (existing) return null;
      const rows = await tx.commissionCollection.findMany({
        where: { ...party, invoiceId: null, receivedAt: { lt: month.end } },
        orderBy: { receivedAt: 'asc' },
      });
      const built = draft(rows.map(toCommissionCollection));
      if (!built) return null;
      // Numéro tiré dans la même transaction (aucun trou), année du mois facturé.
      const year = commissionInvoiceYear(built);
      const invoice: CommissionInvoice = {
        ...built,
        number: formatCommissionInvoiceNumber(year, await nextNumber(tx, 'FCR', year)),
      };
      await tx.commissionInvoice.create({
        data: {
          id: invoice.id,
          number: invoice.number,
          ...party,
          periodStart: invoice.periodStart,
          periodEnd: invoice.periodEnd,
          totalCollected: invoice.totals.collected,
          commissionDeducted: invoice.totals.deducted,
          commissionInvoiced: invoice.totals.invoiced,
          commissionTotal: invoice.totals.total,
          organizationLegalName: invoice.organization?.legalName ?? null,
          organizationAddress: invoice.organization?.address ?? null,
          organizationIfu: invoice.organization?.ifu ?? null,
          organizationRccm: invoice.organization?.rccm ?? null,
          issuedAt: invoice.issuedAt,
          ...commissionSettlementColumns(invoice),
          lines: {
            create: invoice.lines.map((line) => ({
              position: line.position,
              collectionId: line.collectionId,
              caseId: line.caseId,
              caseNumber: line.caseNumber,
              receivedAt: line.receivedAt,
              source: line.source,
              gross: line.gross,
              commission: line.commission,
              settlement: line.settlement,
            })),
          },
        },
      });
      await tx.commissionCollection.updateMany({
        where: { collectionId: { in: invoice.lines.map((line) => line.collectionId) }, invoiceId: null },
        data: { invoiceId: invoice.id },
      });
      await writeEvents(tx, events(invoice));
      return invoice;
    });
  }

  async listDueDebits(now: Date, limit: number): Promise<CommissionInvoice[]> {
    const rows = await this.prisma.commissionInvoice.findMany({
      where: { status: 'pending_payment', nextDebitAttemptAt: { lte: now } },
      include: COMMISSION_INVOICE_INCLUDE,
      orderBy: [{ nextDebitAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toCommissionInvoice);
  }

  async saveDebit(invoice: CommissionInvoice): Promise<boolean> {
    const { count } = await this.prisma.commissionInvoice.updateMany({
      where: { id: invoice.id, version: invoice.version, status: 'pending_payment' },
      data: { ...commissionSettlementColumns(invoice), version: { increment: 1 } },
    });
    return count === 1;
  }

  async findCommissionInvoice(id: string): Promise<CommissionInvoice | null> {
    const row = await this.prisma.commissionInvoice.findUnique({
      where: { id },
      include: COMMISSION_INVOICE_INCLUDE,
    });
    return row ? toCommissionInvoice(row) : null;
  }

  async listCommissionInvoices(
    filter: CommissionInvoiceFilter,
    page: PageRequest,
  ): Promise<PageResult<CommissionInvoice>> {
    const { where: cursor, ...args } = pageArgs(page);
    const rows = await this.prisma.commissionInvoice.findMany({
      where: {
        ...(filter.creditor ? { creditorType: filter.creditor.type, creditorId: filter.creditor.id } : {}),
        ...(filter.creditorId ? { creditorId: filter.creditorId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.periodStart ? { periodStart: filter.periodStart } : {}),
        ...cursor,
      },
      include: COMMISSION_INVOICE_INCLUDE,
      ...args,
    });
    const result = toPage(rows, page.limit);
    return { items: result.items.map(toCommissionInvoice), nextCursor: result.nextCursor };
  }

  async listUnpaidForCreditors(creditors: readonly CreditorRef[]): Promise<CommissionInvoice[]> {
    if (creditors.length === 0) return [];
    const rows = await this.prisma.commissionInvoice.findMany({
      where: {
        status: 'pending_payment',
        OR: creditors.map((creditor) => ({ creditorType: creditor.type, creditorId: creditor.id })),
      },
      include: COMMISSION_INVOICE_INCLUDE,
      orderBy: { id: 'asc' },
    });
    return rows.map(toCommissionInvoice);
  }

  recordFeeReceipt(
    receipt: Omit<FeeReceipt, 'number'>,
    year: number,
    inbox: { eventId: string; consumer: string },
  ): Promise<'recorded' | 'duplicate'> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await markProcessed(tx, inbox))) return 'duplicate' as const;
      // Un reçu par transaction du portefeuille, même reçue par deux événements différents.
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext('billing.fee_receipt:' || $1::text))",
        receipt.walletTransactionId,
      );
      const existing = await tx.feeReceipt.findUnique({
        where: { walletTransactionId: receipt.walletTransactionId },
        select: { id: true },
      });
      if (existing) return 'duplicate' as const;
      await tx.feeReceipt.create({
        data: {
          id: receipt.id,
          number: formatFeeReceiptNumber(year, await nextNumber(tx, 'RFD', year)),
          walletTransactionId: receipt.walletTransactionId,
          kind: receipt.kind,
          payerType: receipt.payer.type,
          payerId: receipt.payer.id,
          caseId: receipt.caseId,
          caseNumber: receipt.caseNumber,
          label: receipt.label,
          amount: receipt.amount,
          paidAt: receipt.paidAt,
          issuedAt: receipt.issuedAt,
        },
      });
      return 'recorded' as const;
    });
  }

  async listFeeReceipts(filter: FeeReceiptFilter, page: PageRequest): Promise<PageResult<FeeReceipt>> {
    const { where: cursor, ...args } = pageArgs(page);
    const rows = await this.prisma.feeReceipt.findMany({
      where: {
        payerType: filter.payer.type,
        payerId: filter.payer.id,
        ...(filter.caseId ? { caseId: filter.caseId } : {}),
        ...cursor,
      },
      ...args,
    });
    const result = toPage(rows, page.limit);
    return { items: result.items.map(toFeeReceipt), nextCursor: result.nextCursor };
  }
}

/** Inbox : false si l'événement a déjà été traité par ce consommateur. */
async function markProcessed(tx: Tx, inbox: { eventId: string; consumer: string }): Promise<boolean> {
  const marked = await tx.$executeRawUnsafe(
    'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ' +
      'ON CONFLICT DO NOTHING',
    inbox.eventId,
    inbox.consumer,
  );
  return marked > 0;
}
