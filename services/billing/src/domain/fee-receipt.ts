import { type CreditorRef } from './commission-invoice';
import { beninDay } from './contract';

/**
 * Reçu des frais du recouvrement (ADR-060 décision 11 ; ADR-064) : un par débit du portefeuille prépayé
 * fait par recovery pour des frais de dossier ou un forfait d'étude, appris par
 * `wallet.prepaid.debited`. Convention de recovery : objet = le dossier, libellé « Frais de dossier
 * RC-… » ou « Forfait d'étude du dossier RC-… ». Idempotent par transaction du portefeuille ; un
 * remboursement ultérieur ne l'annule pas. Numéro `RFD-<année>-<000001>`, continu par année (année
 * du paiement, au Bénin), série distincte des factures.
 */

/** Frais de dossier, ou forfait d'étude ; d'autres natures pourront s'ajouter. */
export type FeeReceiptKind = 'case_fee' | 'study_fee';

/** Service qui débite les frais, et nature du reçu selon l'objet payé chez lui. */
export const FEE_SERVICE = 'recovery';
const KINDS: Readonly<Record<string, FeeReceiptKind>> = {
  recovery_case_fee: 'case_fee',
  recovery_study_fee: 'study_fee',
};

export interface FeeReceipt {
  id: string;
  /** RFD-2026-000001. */
  number: string;
  kind: FeeReceiptKind;
  /** Titulaire du portefeuille débité (le créancier). */
  payer: CreditorRef;
  caseId: string;
  /** Numéro lisible du dossier, lu dans le libellé du débit ; null s'il n'y figure pas. */
  caseNumber: string | null;
  /** Libellé du débit, repris tel quel (jamais de donnée personnelle). */
  label: string;
  amount: number;
  /** Débit du portefeuille : une transaction, un reçu. */
  walletTransactionId: string;
  paidAt: Date;
  issuedAt: Date;
}

/** Nature du reçu d'un débit ; null : ce débit ne donne pas de reçu de frais. */
export function feeReceiptKind(debit: { service: string; objectType: string }): FeeReceiptKind | null {
  if (debit.service !== FEE_SERVICE) return null;
  return Object.hasOwn(KINDS, debit.objectType) ? KINDS[debit.objectType]! : null;
}

const CASE_NUMBER = /\bRC-[0-9]{6,}\b/;

/** Numéro du dossier cité dans le libellé (« Frais de dossier RC-000123 »), ou null. */
export function caseNumberIn(label: string): string | null {
  return CASE_NUMBER.exec(label)?.[0] ?? null;
}

export function formatFeeReceiptNumber(year: number, sequence: number): string {
  return `RFD-${year}-${String(sequence).padStart(6, '0')}`;
}

/** Année du numéro : celle du paiement, au Bénin. */
export function feeReceiptYear(paidAt: Date): number {
  return new Date(beninDay(paidAt) * 86_400_000).getUTCFullYear();
}
