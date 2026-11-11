import { type Holder } from './ledger';

/**
 * Reversement du solde d'un titulaire vers un compte Mobile Money (ADR-042) : le montant est retenu
 * (écriture `payout_hold`) dans la même transaction que la création du reversement, puis transmis à
 * payment (PayoutService), qui l'exécute. L'issue arrive par événement : terminé (écriture
 * `payout_settlement`) ou en échec (écriture `payout_release`, montant rendu au titulaire).
 *
 * `pending_submission` → `submitted` → `completed` | `failed` ; une issue peut arriver avant que la
 * transmission ait été notée (réponse de payment perdue) : elle s'applique quand même.
 *
 * Données personnelles : le numéro complet et le nom du bénéficiaire ne sont gardés que jusqu'à la
 * transmission à payment, qui les conserve pour l'exécution ; wallet ne garde ensuite que le numéro
 * masqué et l'opérateur.
 */
export type WalletPayoutStatus = 'pending_submission' | 'submitted' | 'completed' | 'failed';
export const WALLET_PAYOUT_STATUSES: readonly WalletPayoutStatus[] = [
  'pending_submission',
  'submitted',
  'completed',
  'failed',
];

export type Operator = 'mtn' | 'moov' | 'celtiis';
export const OPERATORS: readonly Operator[] = ['mtn', 'moov', 'celtiis'];

/** Numéro béninois E.164 : +229 suivi de 8 chiffres (ancien plan) ou de 10 (depuis 2024). */
export const BENIN_PHONE = /^\+229(\d{8}|\d{10})$/;

export interface WalletPayout {
  id: string;
  /** Service appelant et sa clé d'idempotence. */
  caller: string;
  idempotencyKey: string;
  holder: Holder;
  amount: number;
  status: WalletPayoutStatus;
  /** Complet jusqu'à la transmission à payment, null ensuite. */
  beneficiaryPhone: string | null;
  beneficiaryName: string | null;
  beneficiaryPhoneMasked: string;
  /**
   * Empreinte (HMAC-SHA256 à clé secrète) du numéro complet, gardée après la transmission : le rejeu
   * d'une demande est jugé sur elle, jamais sur le numéro masqué (ADR-048). null : reversement
   * antérieur à son introduction.
   */
  beneficiaryPhoneHash: string | null;
  beneficiaryOperator: Operator;
  /** Reversement chez payment, null tant qu'il n'est pas transmis. */
  paymentPayoutId: string | null;
  holdTransactionId: string;
  settlementTransactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  version: number;
}

export function maskPhone(phone: string): string {
  return `${phone.slice(0, 4)} •• •• ${phone.slice(-2)}`;
}

export function isSettled(status: WalletPayoutStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/** Transmis à payment : numéro complet et nom effacés. */
export function markSubmitted(payout: WalletPayout, paymentPayoutId: string, now: Date): WalletPayout | null {
  if (payout.status !== 'pending_submission') return null;
  return {
    ...payout,
    status: 'submitted',
    paymentPayoutId,
    beneficiaryPhone: null,
    beneficiaryName: null,
    submittedAt: now,
    updatedAt: now,
  };
}

/** Issue reçue de payment ; null si le reversement est déjà soldé (événement rejoué). */
export function settle(
  payout: WalletPayout,
  input: {
    outcome: 'completed' | 'failed';
    paymentPayoutId: string;
    settlementTransactionId: string;
    now: Date;
  },
): WalletPayout | null {
  if (isSettled(payout.status)) return null;
  const now = input.now;
  return {
    ...payout,
    status: input.outcome,
    paymentPayoutId: payout.paymentPayoutId ?? input.paymentPayoutId,
    beneficiaryPhone: null,
    beneficiaryName: null,
    settlementTransactionId: input.settlementTransactionId,
    ...(input.outcome === 'completed' ? { completedAt: now } : { failedAt: now }),
    updatedAt: now,
  };
}
