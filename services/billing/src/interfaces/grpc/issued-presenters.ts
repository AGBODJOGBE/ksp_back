import { type billingV1 } from '@ksp/contracts';
import { type Invoice } from '../../domain/invoice';

/**
 * Lot E : champs v2 d'une facture émise au paiement (séance, frais de visite ; ADR-055) — objet
 * facturé et références lisibles. Absents d'une facture v1 ou mensuelle, et chacun absent s'il est
 * sans objet.
 */
export function presentIssuance(invoice: Invoice): Partial<billingV1.Invoice> {
  const issuance = invoice.issuance;
  if (!issuance) return {};
  return {
    sourceObject: { ...issuance.sourceObject },
    ...(issuance.requestNumber ? { requestNumber: issuance.requestNumber } : {}),
    ...(issuance.programNumber ? { programNumber: issuance.programNumber } : {}),
    ...(issuance.sessionRank ? { sessionRank: issuance.sessionRank } : {}),
    ...(issuance.placeLabel ? { placeLabel: issuance.placeLabel } : {}),
    ...(issuance.serviceDate ? { serviceDate: issuance.serviceDate } : {}),
  };
}
