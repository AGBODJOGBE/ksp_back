import { type billingV1 } from '@ksp/contracts';
import { type CreditNoteResult } from '../../application/monthly/credit-notes.use-cases';
import { type CreditNote } from '../../domain/credit-note';
import { type InvoiceLine } from '../../domain/invoice';
import { presentInvoice } from './presenters';

/** Présentation gRPC des avoirs (lot F, billing.proto : CreditNote). */
const money = (amount: number) => ({ amount, currency: 'XOF' });

/** Lignes reçues : montants entiers, champs facultatifs gardés s'ils sont renseignés. */
export function parseLines(lines: readonly billingV1.InvoiceLine[]): InvoiceLine[] {
  return lines.map((line) => ({
    label: line.label,
    quantity: line.quantity,
    unitPrice: Number(line.unitPrice?.amount ?? 0),
    amount: Number(line.amount?.amount ?? 0),
    ...(line.serviceDate ? { serviceDate: line.serviceDate } : {}),
    ...(line.programNumber ? { programNumber: line.programNumber } : {}),
    ...(line.sourceObjectId ? { sourceObjectId: line.sourceObjectId } : {}),
  }));
}

export function presentCreditNote(note: CreditNote): billingV1.CreditNote {
  return {
    id: note.id,
    number: note.number,
    invoiceId: note.invoiceId,
    invoiceNumber: note.invoiceNumber,
    customerId: note.customerId,
    organizationId: note.organizationId ?? '',
    lines: note.lines.map((line) => ({
      label: line.label,
      quantity: line.quantity,
      unitPrice: money(line.unitPrice),
      amount: money(line.amount),
    })),
    total: money(note.total),
    reason: note.reason,
    issuedBy: note.issuedBy,
    issuedAt: note.issuedAt.toISOString(),
    appliedToBalance: money(note.appliedToBalance),
    creditedToWallet: money(note.creditedToWallet),
    walletTransactionId: note.walletTransactionId ?? '',
    sourceObject: note.source ?? undefined,
  };
}

export function presentCreditNoteResult(result: CreditNoteResult) {
  return {
    creditNote: presentCreditNote(result.creditNote),
    invoice: presentInvoice(result.invoice),
    created: result.created,
  };
}
