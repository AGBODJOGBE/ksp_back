import {
  type BillableSession as BillableRow,
  type CreditNote as CreditNoteRow,
} from '../../../prisma/generated';
import { type CreditNote } from '../../domain/credit-note';
import {
  type Invoice,
  type InvoiceKind,
  type InvoiceLine,
  type InvoiceSettlement,
} from '../../domain/invoice';
import { type BillableSession, type BillableLineKind } from '../../domain/monthly-invoice';

/**
 * Correspondances base ↔ domaine du lot F (facture mensuelle, séances facturables, avoirs).
 */

/** Factures comptées dans les impayés publiés avec `invoice` : même contrat (v1) ou même titulaire (v2). */
export function overdueScopeWhere(
  invoice: Pick<Invoice, 'contractId' | 'kind' | 'organizationId' | 'customerId'>,
) {
  if (!invoice.kind) return { contractId: invoice.contractId };
  return invoice.organizationId
    ? { kind: { not: null }, organizationId: invoice.organizationId }
    : { kind: { not: null }, organizationId: null, customerId: invoice.customerId };
}

/** Colonnes d'état écrites avec un paiement (le règlement n'est renseigné que pour une facture v2). */
export function paymentState(invoice: Invoice) {
  return {
    status: invoice.status,
    paidAt: invoice.paidAt,
    ...(invoice.kind ? { settledBy: invoice.settledBy ?? null } : {}),
  };
}

/** Champs v2 d'une facture lue en base (absents ou nuls pour une facture v1). */
export function invoiceV2Fields(row: {
  kind: string | null;
  settledBy: string | null;
  creditedAmount: number;
  creditNotesTotal: number;
}) {
  return {
    kind: row.kind as InvoiceKind | null,
    settledBy: row.settledBy as InvoiceSettlement | null,
    creditedAmount: row.creditedAmount,
    creditNotesTotal: row.creditNotesTotal,
  };
}

export function toBillableSession(row: BillableRow): BillableSession {
  return {
    sessionId: row.sessionId,
    organizationId: row.organizationId,
    customerId: row.customerId,
    programId: row.programId,
    programNumber: row.programNumber,
    placeId: row.placeId,
    rank: row.rank,
    sessionsCount: row.sessionsCount,
    kind: row.kind as BillableLineKind,
    occurredAt: row.occurredAt,
    amountDue: row.amountDue,
    visitFeeDeduction: row.visitFeeDeduction,
    invoiceId: row.invoiceId,
  };
}

export function toCreditNote(row: CreditNoteRow & { invoice: { number: string } }): CreditNote {
  return {
    id: row.id,
    number: row.number,
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoice.number,
    customerId: row.customerId,
    organizationId: row.organizationId,
    lines: row.lines as unknown as InvoiceLine[],
    total: row.total,
    reason: row.reason,
    issuedBy: row.issuedBy,
    issuedAt: row.issuedAt,
    appliedToBalance: row.appliedToBalance,
    creditedToWallet: row.creditedToWallet,
    walletTransactionId: row.walletTransactionId,
    source:
      row.sourceObjectType && row.sourceObjectId
        ? { objectType: row.sourceObjectType, objectId: row.sourceObjectId }
        : null,
    idempotencyKey: row.idempotencyKey,
  };
}
