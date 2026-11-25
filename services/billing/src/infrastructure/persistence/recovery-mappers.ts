import {
  type CommissionCollection as CollectionRow,
  type CommissionInvoice as CommissionInvoiceRow,
  type CommissionInvoiceLine as LineRow,
  type FeeReceipt as FeeReceiptRow,
} from '../../../prisma/generated';
import {
  type CollectionSource,
  type CommissionCollection,
  type CommissionDebitFailure,
  type CommissionInvoice,
  type CommissionInvoiceStatus,
  type CommissionSettlement,
  type CreditorType,
} from '../../domain/commission-invoice';
import { type FeeReceipt, type FeeReceiptKind } from '../../domain/fee-receipt';
import { type Tx } from './mappers';

/** Recouvrement (ADR-064) : lignes de la base ↔ objets du domaine. */
export function toCommissionCollection(row: CollectionRow): CommissionCollection {
  return {
    collectionId: row.collectionId,
    creditor: { type: row.creditorType as CreditorType, id: row.creditorId },
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    source: row.source as CollectionSource,
    gross: row.gross,
    commission: row.commission,
    settlement: row.settlement as CommissionSettlement,
    receivedAt: row.receivedAt,
    invoiceId: row.invoiceId,
  };
}

/** Facture lue avec ses lignes, dans l'ordre de la facture. */
export const COMMISSION_INVOICE_INCLUDE = { lines: { orderBy: { position: 'asc' as const } } };

export function toCommissionInvoice(row: CommissionInvoiceRow & { lines: LineRow[] }): CommissionInvoice {
  return {
    id: row.id,
    number: row.number,
    status: row.status as CommissionInvoiceStatus,
    creditor: { type: row.creditorType as CreditorType, id: row.creditorId },
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    lines: row.lines.map((line) => ({
      position: line.position,
      collectionId: line.collectionId,
      caseId: line.caseId,
      caseNumber: line.caseNumber,
      receivedAt: line.receivedAt,
      source: line.source as CollectionSource,
      gross: line.gross,
      commission: line.commission,
      settlement: line.settlement as CommissionSettlement,
    })),
    totals: {
      collected: row.totalCollected,
      deducted: row.commissionDeducted,
      invoiced: row.commissionInvoiced,
      total: row.commissionTotal,
    },
    organization:
      row.organizationLegalName !== null
        ? {
            legalName: row.organizationLegalName,
            address: row.organizationAddress ?? '',
            ifu: row.organizationIfu ?? '',
            rccm: row.organizationRccm,
          }
        : null,
    issuedAt: row.issuedAt,
    paidAt: row.paidAt,
    walletTransactionId: row.walletTransactionId,
    debit: {
      attempts: row.debitAttempts,
      lastAttemptAt: row.lastDebitAttemptAt,
      nextAttemptAt: row.nextDebitAttemptAt,
      lastFailure: row.lastDebitFailure as CommissionDebitFailure | null,
      missingAmount: row.debitMissingAmount,
    },
    version: row.version,
  };
}

/** Règlement et débit automatique : seules colonnes qui changent après l'émission. */
export function commissionSettlementColumns(invoice: CommissionInvoice) {
  return {
    status: invoice.status,
    paidAt: invoice.paidAt,
    walletTransactionId: invoice.walletTransactionId,
    debitAttempts: invoice.debit.attempts,
    lastDebitAttemptAt: invoice.debit.lastAttemptAt,
    nextDebitAttemptAt: invoice.debit.nextAttemptAt,
    lastDebitFailure: invoice.debit.lastFailure,
    debitMissingAmount: invoice.debit.missingAmount,
  };
}

export function toFeeReceipt(row: FeeReceiptRow): FeeReceipt {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind as FeeReceiptKind,
    payer: { type: row.payerType as CreditorType, id: row.payerId },
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    label: row.label,
    amount: row.amount,
    walletTransactionId: row.walletTransactionId,
    paidAt: row.paidAt,
    issuedAt: row.issuedAt,
  };
}

/** Séries de numéros du recouvrement, distinctes des factures (FAC) et des avoirs (AV). */
export type NumberSeries = 'FCR' | 'RFD';

/** Numéro suivant d'une série pour une année, tiré dans la transaction de l'émission (aucun trou). */
export async function nextNumber(tx: Tx, series: NumberSeries, year: number): Promise<number> {
  const [counter] = await tx.$queryRawUnsafe<{ last_number: number }[]>(
    'INSERT INTO series_counters (series, year, last_number) VALUES ($1, $2, 1) ' +
      'ON CONFLICT (series, year) DO UPDATE SET last_number = series_counters.last_number + 1 ' +
      'RETURNING last_number',
    series,
    year,
  );
  return Number(counter!.last_number);
}
