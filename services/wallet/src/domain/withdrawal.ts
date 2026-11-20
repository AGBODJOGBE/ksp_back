import { type Holder } from './ledger';
import { type Operator } from './wallet-payout';

/**
 * Retrait du portefeuille prépayé vers un compte Mobile Money (CDC Nettoyage v2, R-WL-04 ; ADR-055,
 * décision 8). Demandé par le client, le montant est retenu aussitôt (écriture `withdrawal_hold`),
 * puis la finance le traite et une deuxième personne le valide ; payment exécute le virement
 * (PayoutService, mécanisme des reversements d'ADR-041, référence `wallet_withdrawal:<id>`).
 *
 * `requested` → `awaiting_approval` (traité) → `submitted` (validé et transmis) → `completed` |
 * `failed` (montant rendu) ; `requested` ou `awaiting_approval` non validé → `rejected` (montant
 * rendu). La validation est notée avant la transmission : payment injoignable, le retrait reste validé
 * et non transmis, et la validation rejouée le transmet. Un retrait validé ne se refuse plus (payment
 * a pu recevoir la demande).
 *
 * Données personnelles : numéro complet et nom gardés jusqu'à la transmission à payment (ou jusqu'au
 * refus), comme pour un reversement ; ensuite, numéro masqué, empreinte et opérateur seulement.
 */
export type WithdrawalStatus =
  'requested' | 'awaiting_approval' | 'submitted' | 'completed' | 'failed' | 'rejected';
export const WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = [
  'requested',
  'awaiting_approval',
  'submitted',
  'completed',
  'failed',
  'rejected',
];

export interface Withdrawal {
  id: string;
  /** Clé d'idempotence du titulaire (en-tête Idempotency-Key). */
  idempotencyKey: string;
  holder: Holder;
  amount: number;
  status: WithdrawalStatus;
  beneficiaryPhone: string | null;
  beneficiaryName: string | null;
  beneficiaryPhoneMasked: string;
  /** Empreinte HMAC du numéro complet : rejeu d'une demande jugé sur elle (ADR-048). */
  beneficiaryPhoneHash: string;
  beneficiaryOperator: Operator;
  /** Compte qui l'a demandé (titulaire, ou administrateur de l'organisation). */
  requestedBy: string;
  requestedAt: Date;
  processedBy: string | null;
  processedAt: Date | null;
  processingNote: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  /** Reversement chez payment, null tant qu'il n'est pas transmis. */
  paymentPayoutId: string | null;
  holdTransactionId: string;
  /** Écriture qui l'a soldé (sortie, ou montant rendu), null en cours. */
  settlementTransactionId: string | null;
  completedAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
  version: number;
}

/** Retraits pas encore terminés : leur montant est retenu (déjà déduit du solde). */
export const WITHDRAWALS_IN_PROGRESS: readonly WithdrawalStatus[] = [
  'requested',
  'awaiting_approval',
  'submitted',
];

export function isWithdrawalClosed(status: WithdrawalStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'rejected';
}

const REFERENCE_PREFIX = 'wallet_withdrawal:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Référence transmise à payment, reprise dans payment.payout.completed et failed. */
export function withdrawalPayoutReference(id: string): string {
  return `${REFERENCE_PREFIX}${id}`;
}

/** Identifiant du retrait d'après la référence d'un reversement ; null pour une autre référence. */
export function withdrawalIdFromReference(reference: string): string | null {
  if (!reference.startsWith(REFERENCE_PREFIX)) return null;
  const id = reference.slice(REFERENCE_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** Première personne de la finance : vérifications faites, la demande attend une validation. */
export function processWithdrawal(
  withdrawal: Withdrawal,
  input: { staffId: string; note: string; now: Date },
): Withdrawal | null {
  if (withdrawal.status !== 'requested') return null;
  return {
    ...withdrawal,
    status: 'awaiting_approval',
    processedBy: input.staffId,
    processedAt: input.now,
    processingNote: input.note,
    updatedAt: input.now,
  };
}

/**
 * Deuxième personne (jamais celle qui a traité) : validation notée, le retrait reste à transmettre.
 * null : état incompatible, déjà validé, ou validation par la personne qui l'a traité.
 */
export function approveWithdrawal(
  withdrawal: Withdrawal,
  input: { staffId: string; now: Date },
): Withdrawal | null {
  if (withdrawal.status !== 'awaiting_approval' || withdrawal.approvedBy !== null) return null;
  if (withdrawal.processedBy === input.staffId) return null;
  return { ...withdrawal, approvedBy: input.staffId, approvedAt: input.now, updatedAt: input.now };
}

/** Transmis à payment : numéro complet et nom effacés. */
export function markWithdrawalSubmitted(
  withdrawal: Withdrawal,
  paymentPayoutId: string,
  now: Date,
): Withdrawal | null {
  if (withdrawal.status !== 'awaiting_approval' || withdrawal.approvedBy === null) return null;
  return {
    ...withdrawal,
    status: 'submitted',
    paymentPayoutId,
    beneficiaryPhone: null,
    beneficiaryName: null,
    updatedAt: now,
  };
}

/**
 * Issue reçue de payment. Elle peut arriver avant que la transmission soit notée (réponse perdue) :
 * elle s'applique à un retrait validé. null : retrait déjà soldé (événement rejoué) ou jamais validé.
 */
export function settleWithdrawal(
  withdrawal: Withdrawal,
  input: {
    outcome: 'completed' | 'failed';
    paymentPayoutId: string;
    settlementTransactionId: string;
    now: Date;
  },
): Withdrawal | null {
  const transmitted =
    withdrawal.status === 'submitted' ||
    (withdrawal.status === 'awaiting_approval' && withdrawal.approvedBy !== null);
  if (!transmitted) return null;
  return {
    ...withdrawal,
    status: input.outcome,
    paymentPayoutId: withdrawal.paymentPayoutId ?? input.paymentPayoutId,
    beneficiaryPhone: null,
    beneficiaryName: null,
    settlementTransactionId: input.settlementTransactionId,
    ...(input.outcome === 'completed' ? { completedAt: input.now } : { failedAt: input.now }),
    updatedAt: input.now,
  };
}

/** Refus motivé avant la validation : le montant retenu est rendu (écriture de restitution). */
export function rejectWithdrawal(
  withdrawal: Withdrawal,
  input: { staffId: string; reason: string; settlementTransactionId: string; now: Date },
): Withdrawal | null {
  const open =
    withdrawal.status === 'requested' ||
    (withdrawal.status === 'awaiting_approval' && withdrawal.approvedBy === null);
  if (!open) return null;
  return {
    ...withdrawal,
    status: 'rejected',
    rejectedBy: input.staffId,
    rejectedAt: input.now,
    rejectionReason: input.reason,
    beneficiaryPhone: null,
    beneficiaryName: null,
    settlementTransactionId: input.settlementTransactionId,
    updatedAt: input.now,
  };
}
