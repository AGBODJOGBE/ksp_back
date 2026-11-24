import { beninDay } from './contract';
import { type Invoice, type InvoiceLineKind } from './invoice';

/**
 * Lot E — facture de séance d'un particulier (R-PP-06) et reçu des frais de visite (R-FV-04),
 * émis au paiement par cleaning (InvoiceIssuanceService.IssueInvoice ; ADR-055 décisions 4 et 9).
 */

/** Objet facturé chez le service source (séance, demande). */
export interface InvoiceSourceObject {
  objectType: string;
  objectId: string;
}

/**
 * Émission d'une facture par un service métier : une seule par (émetteur, clé), une seule par
 * facture. Porte l'objet facturé et ses références lisibles — jamais d'adresse ni de position.
 */
export interface InvoiceIssuance {
  /** Service appelant (jeton de service) : "cleaning". */
  issuer: string;
  idempotencyKey: string;
  /** Empreinte du contenu de la requête : la même clé avec un autre contenu est refusée. */
  fingerprint: string;
  sourceObject: InvoiceSourceObject;
  /** Dossier DN-…, programme PN-…, rang « 3/15 », nom du lieu donné par le client. */
  requestNumber: string | null;
  programNumber: string | null;
  sessionRank: string | null;
  placeLabel: string | null;
  /** Jour de la séance, AAAA-MM-JJ (heure du Bénin) ; null pour des frais de visite. */
  serviceDate: string | null;
  createdAt: Date;
}

/** Natures des lignes (billing.proto, InvoiceLine.kind) ; `visit_fee_deduction` est la seule négative. */
export const INVOICE_LINE_KINDS: readonly InvoiceLineKind[] = [
  'session',
  'missed_session',
  'late_cancellation',
  'visit_fee',
  'visit_fee_deduction',
  'adjustment',
];

/**
 * Année du numéro d'une facture émise au paiement : celle du paiement, au Bénin, à défaut celle de
 * l'émission.
 */
export function paidInvoiceYear(invoice: Pick<Invoice, 'paidAt' | 'issuedAt'>): number {
  return new Date(beninDay(invoice.paidAt ?? invoice.issuedAt) * 86_400_000).getUTCFullYear();
}
