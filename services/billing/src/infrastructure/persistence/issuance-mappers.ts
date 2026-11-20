import { type InvoiceIssuance as IssuanceRow } from '../../../prisma/generated';
import { type InvoiceKind } from '../../domain/invoice';
import { type InvoiceIssuance } from '../../domain/issued-invoice';

/**
 * Lot E : facture émise au paiement par cleaning (ADR-055). Ce qui est propre à l'émission vit
 * dans invoice_issuances (migration 0009), la nature de la facture dans invoices.kind (lot F).
 */

/** Nature et émission lues avec la facture ; émission absente (null) si elle n'a pas été chargée. */
export function issuedInvoiceFields(row: { kind: string | null; issuance?: IssuanceRow | null }) {
  return {
    kind: row.kind as InvoiceKind | null,
    issuance: row.issuance ? toIssuance(row.issuance) : null,
  };
}

function toIssuance(row: IssuanceRow): InvoiceIssuance {
  return {
    issuer: row.issuer,
    idempotencyKey: row.idempotencyKey,
    fingerprint: row.fingerprint,
    sourceObject: { objectType: row.sourceObjectType, objectId: row.sourceObjectId },
    requestNumber: row.requestNumber,
    programNumber: row.programNumber,
    sessionRank: row.sessionRank,
    placeLabel: row.placeLabel,
    // Colonne DATE, lue à minuit UTC : AAAA-MM-JJ.
    serviceDate: row.serviceDate ? row.serviceDate.toISOString().slice(0, 10) : null,
    createdAt: row.createdAt,
  };
}

/** Ligne invoice_issuances d'une facture émise, écrite une seule fois. */
export function issuanceColumns(invoiceId: string, issuance: InvoiceIssuance) {
  return {
    issuer: issuance.issuer,
    idempotencyKey: issuance.idempotencyKey,
    invoiceId,
    fingerprint: issuance.fingerprint,
    sourceObjectType: issuance.sourceObject.objectType,
    sourceObjectId: issuance.sourceObject.objectId,
    requestNumber: issuance.requestNumber,
    programNumber: issuance.programNumber,
    sessionRank: issuance.sessionRank,
    placeLabel: issuance.placeLabel,
    serviceDate: issuance.serviceDate ? new Date(`${issuance.serviceDate}T00:00:00.000Z`) : null,
    createdAt: issuance.createdAt,
  };
}
