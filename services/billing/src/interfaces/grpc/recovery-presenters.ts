import { type billingV1 } from '@ksp/contracts';
import {
  commissionBalance,
  type CommissionInvoice,
  periodLabel,
  receivedOn,
} from '../../domain/commission-invoice';
import { type FeeReceipt } from '../../domain/fee-receipt';

/** Recouvrement (ADR-064) : facture de commission et reçu de frais en messages ksp.billing.v1. */
const money = (amount: number) => ({ amount, currency: 'XOF' });
const iso = (date: Date | null) => (date ? date.toISOString() : '');

export function presentCommissionInvoice(invoice: CommissionInvoice): billingV1.CommissionInvoice {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    creditor: { type: invoice.creditor.type, id: invoice.creditor.id },
    period: periodLabel(invoice),
    periodStart: iso(invoice.periodStart),
    periodEnd: iso(invoice.periodEnd),
    lines: invoice.lines.map((line) => ({
      caseId: line.caseId,
      caseNumber: line.caseNumber,
      collectionId: line.collectionId,
      receivedAt: iso(line.receivedAt),
      receivedOn: receivedOn(line),
      source: line.source,
      gross: money(line.gross),
      commission: money(line.commission),
      settlement: line.settlement,
    })),
    totalCollected: money(invoice.totals.collected),
    commissionDeducted: money(invoice.totals.deducted),
    commissionInvoiced: money(invoice.totals.invoiced),
    commissionTotal: money(invoice.totals.total),
    balance: money(commissionBalance(invoice)),
    // Décision du 2026-11-23 : aucune ligne de TVA, montants affichés « hors taxe ».
    amountsExcludingTax: true,
    issuedAt: iso(invoice.issuedAt),
    paidAt: iso(invoice.paidAt),
    walletTransactionId: invoice.walletTransactionId ?? '',
    // Absent sans commission à débiter : rien n'a été ni ne sera débité.
    debit:
      invoice.totals.invoiced > 0
        ? {
            attempts: invoice.debit.attempts,
            lastAttemptAt: iso(invoice.debit.lastAttemptAt),
            nextAttemptAt: iso(invoice.debit.nextAttemptAt),
            lastFailure: invoice.debit.lastFailure ?? '',
            missing: invoice.debit.missingAmount ? money(invoice.debit.missingAmount) : undefined,
          }
        : undefined,
    organization: invoice.organization
      ? {
          legalName: invoice.organization.legalName,
          address: invoice.organization.address,
          ifu: invoice.organization.ifu,
          rccm: invoice.organization.rccm ?? '',
        }
      : undefined,
  };
}

export function presentFeeReceipt(receipt: FeeReceipt): billingV1.FeeReceipt {
  return {
    id: receipt.id,
    number: receipt.number,
    kind: receipt.kind,
    payer: { type: receipt.payer.type, id: receipt.payer.id },
    caseId: receipt.caseId,
    caseNumber: receipt.caseNumber ?? '',
    label: receipt.label,
    amount: money(receipt.amount),
    paidAt: iso(receipt.paidAt),
    issuedAt: iso(receipt.issuedAt),
    walletTransactionId: receipt.walletTransactionId,
  };
}
