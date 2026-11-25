import { beninDay } from './contract';
import { type InvoiceOrganization } from './invoice';
import { beninDate, type BillingMonth, billingMonth, monthOf } from './monthly-invoice';

/**
 * Facture mensuelle de commission du recouvrement (ADR-060 décision 11, R-CO-05 ; ADR-064).
 *
 * - Le 1er de chaque mois (heure du Bénin), une facture par créancier (compte ou organisation) pour
 *   ses encaissements du mois écoulé, appris par `recovery.payment.collected`. Mois d'un encaissement :
 *   mois civil à Porto-Novo de sa réception ; un encaissement arrivé après l'émission de la facture de
 *   son mois part sur la facture suivante (comme les séances du Nettoyage, R-PE-07).
 * - Une ligne par encaissement : dossier, date, origine, brut, commission, mode de règlement.
 * - Hors taxe : aucune ligne de TVA (décision du 2026-11-23).
 * - Commission `deducted` (retenue à l'encaissement) : déjà réglée. Commission `invoiced` (paiement
 *   reçu directement par le créancier) : débitée par billing du portefeuille prépayé du créancier à
 *   l'émission, puis de nouveau après un délai tant que le solde ne suffit pas. Sans part `invoiced`,
 *   la facture est réglée dès son émission.
 * - Numéro `FCR-<année>-<000001>`, continu par année, série distincte des factures du Nettoyage ;
 *   année du mois facturé (la facture de décembre émise en janvier garde son année).
 */

export type CreditorType = 'user' | 'organization';

/** Créancier titulaire des dossiers, ou titulaire du portefeuille débité : identifiants seulement. */
export interface CreditorRef {
  type: CreditorType;
  id: string;
}

export type CommissionSettlement = 'deducted' | 'invoiced';
export type CollectionSource =
  'payment_link' | 'offline_cash' | 'offline_transfer' | 'partner' | 'direct_to_creditor';

/** Encaissement d'un dossier, appris par `recovery.payment.collected` (montants entiers en XOF). */
export interface CommissionCollection {
  collectionId: string;
  creditor: CreditorRef;
  caseId: string;
  /** Numéro lisible du dossier (RC-…). */
  caseNumber: string;
  source: CollectionSource;
  /** Montant encaissé (brut), jamais nul. */
  gross: number;
  /** Commission de l'encaissement, 0 possible. */
  commission: number;
  settlement: CommissionSettlement;
  receivedAt: Date;
  /** Facture qui porte l'encaissement ; null tant qu'il n'est pas facturé. */
  invoiceId: string | null;
}

/** Ligne figée sur la facture : une par encaissement. */
export interface CommissionInvoiceLine {
  /** Rang dans la facture, à partir de 1. */
  position: number;
  collectionId: string;
  caseId: string;
  caseNumber: string;
  receivedAt: Date;
  source: CollectionSource;
  gross: number;
  commission: number;
  settlement: CommissionSettlement;
}

export interface CommissionTotals {
  /** Somme des montants encaissés. */
  collected: number;
  /** Commission retenue à l'encaissement, déjà réglée. */
  deducted: number;
  /** Commission à débiter du portefeuille du créancier. */
  invoiced: number;
  /** deducted + invoiced. */
  total: number;
}

/** `cancelled` est réservé : aucune annulation n'est prévue aujourd'hui. */
export type CommissionInvoiceStatus = 'pending_payment' | 'paid' | 'cancelled';
export const COMMISSION_INVOICE_STATUSES: readonly CommissionInvoiceStatus[] = [
  'pending_payment',
  'paid',
  'cancelled',
];

/** Échec du dernier débit : solde insuffisant, ou wallet indisponible ou qui refuse. */
export type CommissionDebitFailure = 'insufficient_funds' | 'wallet_error';

/** Débit automatique de la commission `invoiced` (sans objet si elle est nulle). */
export interface CommissionDebitState {
  attempts: number;
  lastAttemptAt: Date | null;
  /** Prochaine tentative ; null une fois la facture réglée ou sans commission à débiter. */
  nextAttemptAt: Date | null;
  lastFailure: CommissionDebitFailure | null;
  /** Montant manquant au dernier essai (solde insuffisant) ; null sinon. */
  missingAmount: number | null;
}

export interface CommissionInvoice {
  id: string;
  /** FCR-2026-000001. */
  number: string;
  status: CommissionInvoiceStatus;
  creditor: CreditorRef;
  /** Mois facturé : minuit (heure du Bénin) ; `periodEnd` est exclusive. */
  periodStart: Date;
  periodEnd: Date;
  lines: CommissionInvoiceLine[];
  totals: CommissionTotals;
  /** En-tête d'une organisation créancière, copié d'identity à l'émission ; null pour un compte. */
  organization: InvoiceOrganization | null;
  issuedAt: Date;
  paidAt: Date | null;
  /** Débit du portefeuille qui a réglé la commission `invoiced`. */
  walletTransactionId: string | null;
  debit: CommissionDebitState;
  version: number;
}

/** Type d'objet payé chez wallet, et clé d'idempotence stable du débit (une par facture). */
export const COMMISSION_DEBIT_OBJECT_TYPE = 'billing_commission_invoice';
export const commissionDebitKey = (invoiceId: string) => `${COMMISSION_DEBIT_OBJECT_TYPE}:${invoiceId}`;

export function formatCommissionInvoiceNumber(year: number, sequence: number): string {
  return `FCR-${year}-${String(sequence).padStart(6, '0')}`;
}

/** Année du numéro : celle du mois facturé, au Bénin. */
export function commissionInvoiceYear(invoice: Pick<CommissionInvoice, 'periodStart'>): number {
  return new Date(beninDay(invoice.periodStart) * 86_400_000).getUTCFullYear();
}

/** Mois facturé AAAA-MM. */
export function periodLabel(invoice: Pick<CommissionInvoice, 'periodStart'>): string {
  const { year, month } = monthOf(invoice.periodStart);
  return `${year}-${String(month).padStart(2, '0')}`;
}

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Mois AAAA-MM lu au Bénin ; null s'il est mal formé. */
export function parsePeriod(value: string): BillingMonth | null {
  const match = PERIOD.exec(value);
  return match ? billingMonth(Number(match[1]), Number(match[2])) : null;
}

/** Encaissements à porter sur la facture d'un mois : non facturés, reçus avant la fin du mois. */
export function collectionsToInvoice(
  collections: readonly CommissionCollection[],
  month: Pick<BillingMonth, 'end'>,
): CommissionCollection[] {
  return collections.filter(
    (collection) => collection.invoiceId === null && collection.receivedAt.getTime() < month.end.getTime(),
  );
}

/** Lignes de la facture, par date d'encaissement (puis dossier, puis encaissement). */
export function commissionInvoiceLines(
  collections: readonly CommissionCollection[],
): CommissionInvoiceLine[] {
  return [...collections]
    .sort(
      (a, b) =>
        a.receivedAt.getTime() - b.receivedAt.getTime() ||
        a.caseNumber.localeCompare(b.caseNumber) ||
        a.collectionId.localeCompare(b.collectionId),
    )
    .map((collection, index) => ({
      position: index + 1,
      collectionId: collection.collectionId,
      caseId: collection.caseId,
      caseNumber: collection.caseNumber,
      receivedAt: collection.receivedAt,
      source: collection.source,
      gross: collection.gross,
      commission: collection.commission,
      settlement: collection.settlement,
    }));
}

export function commissionTotals(lines: readonly CommissionInvoiceLine[]): CommissionTotals {
  const sum = (settlement: CommissionSettlement) =>
    lines
      .filter((line) => line.settlement === settlement)
      .reduce((total, line) => total + line.commission, 0);
  const deducted = sum('deducted');
  const invoiced = sum('invoiced');
  return {
    collected: lines.reduce((total, line) => total + line.gross, 0),
    deducted,
    invoiced,
    total: deducted + invoiced,
  };
}

/** Jour de l'encaissement (AAAA-MM-JJ, heure du Bénin). */
export const receivedOn = (line: Pick<CommissionInvoiceLine, 'receivedAt'>) => beninDate(line.receivedAt);

/**
 * Facture de commission à émettre (sans numéro : il est tiré dans la transaction de l'émission).
 * Sans commission à débiter, elle est réglée dès l'émission ; sinon elle est due et le premier débit
 * est à faire tout de suite.
 */
export function draftCommissionInvoice(input: {
  id: string;
  creditor: CreditorRef;
  month: BillingMonth;
  collections: readonly CommissionCollection[];
  organization: InvoiceOrganization | null;
  now: Date;
}): Omit<CommissionInvoice, 'number'> {
  const lines = commissionInvoiceLines(input.collections);
  if (lines.length === 0) throw new Error('Facture de commission sans encaissement.');
  const totals = commissionTotals(lines);
  const settled = totals.invoiced === 0;
  return {
    id: input.id,
    status: settled ? 'paid' : 'pending_payment',
    creditor: input.creditor,
    periodStart: input.month.start,
    periodEnd: input.month.end,
    lines,
    totals,
    organization: input.creditor.type === 'organization' ? input.organization : null,
    issuedAt: input.now,
    paidAt: settled ? input.now : null,
    walletTransactionId: null,
    debit: {
      attempts: 0,
      lastAttemptAt: null,
      nextAttemptAt: settled ? null : input.now,
      lastFailure: null,
      missingAmount: null,
    },
    version: 0,
  };
}

/** Reste à débiter : la commission `invoiced` tant que la facture est due. */
export function commissionBalance(invoice: Pick<CommissionInvoice, 'status' | 'totals'>): number {
  return invoice.status === 'pending_payment' ? invoice.totals.invoiced : 0;
}

/** Commission débitée du portefeuille : facture réglée. */
export function withCommissionDebited(
  invoice: CommissionInvoice,
  walletTransactionId: string,
  at: Date,
): CommissionInvoice {
  return {
    ...invoice,
    status: 'paid',
    paidAt: at,
    walletTransactionId,
    debit: {
      attempts: invoice.debit.attempts + 1,
      lastAttemptAt: at,
      nextAttemptAt: null,
      lastFailure: null,
      missingAmount: null,
    },
  };
}

/** Débit refusé ou impossible : la facture reste due, nouvel essai à `nextAttemptAt`. */
export function withCommissionDebitFailed(
  invoice: CommissionInvoice,
  failure: { reason: CommissionDebitFailure; missingAmount: number | null; at: Date; nextAttemptAt: Date },
): CommissionInvoice {
  return {
    ...invoice,
    debit: {
      attempts: invoice.debit.attempts + 1,
      lastAttemptAt: failure.at,
      nextAttemptAt: failure.nextAttemptAt,
      lastFailure: failure.reason,
      missingAmount: failure.reason === 'insufficient_funds' ? failure.missingAmount : null,
    },
  };
}
