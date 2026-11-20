import { beninDay } from './contract';
import { balance, type Invoice, type InvoiceLine, paidAmount } from './invoice';

/**
 * Avoirs et annulation d'une facture (lot F ; R-PE-07, R-RC-03 ; billing.proto, IssueCreditNote).
 *
 * - Une facture émise ne se modifie jamais : une erreur se corrige par un avoir.
 * - Le total des avoirs d'une facture ne dépasse jamais son total.
 * - L'avoir réduit d'abord le reste dû ; la part au-delà (facture déjà payée) est créditée au
 *   portefeuille du titulaire (R-WL-04 : jamais une sortie d'argent automatique).
 * - Un avoir qui ramène le reste dû à 0 solde la facture (`settledBy` credit_note, RV-87) ; une
 *   annulation la solde aussi (`cancellation`) : les deux publient `billing.invoice.paid`.
 */
export interface CreditNoteSource {
  objectType: string;
  objectId: string;
}

export interface CreditNote {
  id: string;
  /** AV-<année>-<numéro sur 6 chiffres>, continu par année. */
  number: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  organizationId: string | null;
  /** Montants positifs. */
  lines: InvoiceLine[];
  total: number;
  /** Motif visible du client. */
  reason: string;
  /** Compte du back-office, ou « service:cleaning ». */
  issuedBy: string;
  issuedAt: Date;
  appliedToBalance: number;
  creditedToWallet: number;
  /** Transaction wallet du crédit ; null sans crédit au portefeuille. */
  walletTransactionId: string | null;
  source: CreditNoteSource | null;
  /** Clé d'idempotence, propre à l'émetteur (`issuedBy`). */
  idempotencyKey: string;
}

/** Année du numéro d'avoir : année civile de l'émission, au Bénin. */
export function creditNoteYear(issuedAt: Date): number {
  return new Date(beninDay(issuedAt) * 86_400_000).getUTCFullYear();
}

export function formatCreditNoteNumber(year: number, sequence: number): string {
  return `AV-${year}-${String(sequence).padStart(6, '0')}`;
}

export const CREDIT_NOTE_MAX_LINES = 50;
export const CREDIT_NOTE_REASON_MAX = 500;

/** Champ invalide d'une demande d'avoir (lignes positives, 1 à 50 ; motif 1 à 500 caractères), ou null. */
export function creditNoteProblem(lines: readonly InvoiceLine[], reason: string): string | null {
  if (lines.length === 0 || lines.length > CREDIT_NOTE_MAX_LINES) return 'lines';
  const invalid = lines.some(
    (line) =>
      !line.label.trim() ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      !Number.isInteger(line.amount) ||
      line.amount <= 0 ||
      !Number.isInteger(line.unitPrice) ||
      line.unitPrice <= 0,
  );
  if (invalid) return 'lines';
  const text = reason.trim();
  if (!text || text.length > CREDIT_NOTE_REASON_MAX) return 'reason';
  return null;
}

export type CreditNoteRefusal =
  { code: 'invalid_transition'; status: Invoice['status'] } | { code: 'exceeds_invoice'; maximum: number };

type CreditableInvoice = Pick<
  Invoice,
  'status' | 'total' | 'payments' | 'creditedAmount' | 'creditNotesTotal' | 'kind'
>;

/** Montant encore créditable : total de la facture moins les avoirs déjà émis. */
export function creditableAmount(invoice: CreditableInvoice): number {
  return Math.max(0, invoice.total - (invoice.creditNotesTotal ?? 0));
}

/**
 * Répartition d'un avoir : d'abord le reste dû, puis le portefeuille. Refus : facture annulée, ou
 * avoirs au-delà du total (`maximum` = montant encore créditable).
 */
export function splitCreditNote(
  invoice: CreditableInvoice,
  amount: number,
): { appliedToBalance: number; creditedToWallet: number } | CreditNoteRefusal {
  if (invoice.status === 'cancelled') return { code: 'invalid_transition', status: invoice.status };
  const maximum = creditableAmount(invoice);
  if (amount > maximum) return { code: 'exceeds_invoice', maximum };
  const appliedToBalance = Math.min(amount, balance(invoice));
  return { appliedToBalance, creditedToWallet: amount - appliedToBalance };
}

/**
 * Facture après un avoir : la part imputée réduit le reste dû ; reste dû ramené à 0 sur une facture
 * ouverte → « payée », soldée par l'avoir. `settled` : la facture vient d'être soldée.
 */
export function withCreditNote<T extends Invoice>(
  invoice: T,
  split: { appliedToBalance: number; creditedToWallet: number },
  at: Date,
): { invoice: T; settled: boolean } {
  const next: T = {
    ...invoice,
    creditedAmount: (invoice.creditedAmount ?? 0) + split.appliedToBalance,
    creditNotesTotal: (invoice.creditNotesTotal ?? 0) + split.appliedToBalance + split.creditedToWallet,
  };
  const open = invoice.status === 'pending_payment' || invoice.status === 'overdue';
  if (!open || balance(next) > 0) return { invoice: next, settled: false };
  return { invoice: { ...next, status: 'paid', paidAt: at, settledBy: 'credit_note' }, settled: true };
}

/**
 * Annulation d'une facture v2 ouverte (« en attente » ou « impayée ») sans aucun paiement : elle
 * sort du compte des impayés (`settledBy` cancellation). Refus : facture v1, déjà soldée ou
 * annulée, ou déjà partiellement payée (à corriger par un avoir).
 */
export function cancelInvoice<T extends Invoice>(
  invoice: T,
): { invoice: T } | { refusal: 'invalid_transition' | 'partially_paid' } {
  const open = invoice.status === 'pending_payment' || invoice.status === 'overdue';
  if (!invoice.kind || !open) return { refusal: 'invalid_transition' };
  if (paidAmount(invoice) > 0) return { refusal: 'partially_paid' };
  return { invoice: { ...invoice, status: 'cancelled', paidAt: null, settledBy: 'cancellation' } };
}
