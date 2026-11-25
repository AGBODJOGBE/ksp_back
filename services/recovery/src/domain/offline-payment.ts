import { type CollectionSource } from './collection';
import { type Outcome, refusal, success } from './outcome';

/**
 * Somme reçue hors du lien de paiement (R-EN-01, R-AR-03, R-HU-05 ; message `OfflinePayment` du
 * contrat) : espèces au guichet, virement, ou encaissement déclaré par un huissier ou un avocat. Elle
 * est saisie par une personne et validée par une autre (validation à deux) ; elle n'est imputée et
 * créditée qu'à la validation (ADR-060, point 8).
 */
export type OfflinePaymentSource = 'cash' | 'transfer' | 'partner';

export type OfflinePaymentStatus = 'pending_approval' | 'approved' | 'rejected';

export const OFFLINE_PAYMENT_SOURCES: readonly OfflinePaymentSource[] = ['cash', 'transfer', 'partner'];
export const OFFLINE_PAYMENT_STATUSES: readonly OfflinePaymentStatus[] = [
  'pending_approval',
  'approved',
  'rejected',
];

/** Origine de l'encaissement créé à la validation. */
export const COLLECTION_SOURCE: Readonly<Record<OfflinePaymentSource, CollectionSource>> = {
  cash: 'offline_cash',
  transfer: 'offline_transfer',
  partner: 'partner',
};

/** Ce que la validation à deux regarde : l'état de la saisie et son auteur. */
export interface PendingReview {
  status: OfflinePaymentStatus;
  recordedBy: string;
}

/**
 * Validation ou refus par une deuxième personne (R-AR-03) : jamais l'auteur de la saisie
 * (`RECOVERY_APPROVAL_BY_REQUESTER`), et seulement tant que la saisie attend
 * (`RECOVERY_INVALID_TRANSITION` sinon). Le même contrôle vaut pour toute somme déclarée par un
 * tiers et validée par la finance.
 */
export function review(
  payment: PendingReview,
  reviewerId: string,
  decision: 'approved' | 'rejected',
): Outcome<OfflinePaymentStatus> {
  if (payment.status !== 'pending_approval') {
    return refusal('RECOVERY_INVALID_TRANSITION', 'Ce paiement hors ligne a déjà été traité');
  }
  if (payment.recordedBy === reviewerId) {
    return refusal(
      'RECOVERY_APPROVAL_BY_REQUESTER',
      'Une autre personne que l’auteur de la saisie doit la valider ou la refuser.',
    );
  }
  return success(decision);
}
