import { ExecutionRuleError } from '../sessions/errors';
import {
  effectivePaymentStatus,
  isPayable,
  type PayerKind,
  type SessionPaymentStatus,
} from './payment-status';

/**
 * Paiement direct par Mobile Money (R-WL-05, R-PP-03, R-PP-07) : le client paie ce qui manque à son
 * solde ; le paiement crédite le wallet, puis le montant dû est débité aussitôt (un seul chemin, pas
 * de double paiement). Un seul paiement direct en cours par objet (RV-90).
 */
export type DirectPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'expired' | 'left_in_wallet';

export interface DirectPaymentRecord {
  id: string;
  status: DirectPaymentStatus;
  amount: number;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  /** Le débit de l'objet a suivi le crédit du wallet. */
  debited: boolean;
}

export type PaySessionPlan =
  | { kind: 'debit_wallet' }
  | { kind: 'existing_page'; payment: DirectPaymentRecord }
  | { kind: 'awaiting_payment' }
  | { kind: 'new_page'; amount: number; expiresAt: Date };

/**
 * R-PP-07 : une page expire au plus tard à l'échéance de l'objet. Interprétation : une séance déjà en
 * retard n'a plus d'échéance à venir (elle reste payable) ; la page garde alors celle du prestataire.
 */
export function directPaymentExpiry(providerExpiry: Date, objectDeadline: Date | null, now: Date): Date {
  if (objectDeadline === null || objectDeadline.getTime() <= now.getTime()) return providerExpiry;
  return objectDeadline.getTime() < providerExpiry.getTime() ? objectDeadline : providerExpiry;
}

function isLivePage(payment: DirectPaymentRecord, now: Date): boolean {
  return (
    payment.status === 'pending' &&
    (payment.expiresAt === null || payment.expiresAt.getTime() > now.getTime())
  );
}

/**
 * PaySession. Interprétation : quand le solde couvre déjà le montant, le wallet est débité, même si le
 * client a choisi Mobile Money (il n'y a rien à lui faire payer en plus).
 */
export function paySession(input: {
  payerKind: PayerKind;
  paymentStatus: SessionPaymentStatus | null;
  dueBy: Date | null;
  netAmount: number;
  balance: number;
  method: 'wallet' | 'mobile_money';
  directPayments: readonly DirectPaymentRecord[];
  providerExpiry: Date;
  now: Date;
}): PaySessionPlan {
  if (input.payerKind === 'organization') throw new ExecutionRuleError('CLEANING_PAYMENT_VIA_INVOICE');
  const status = effectivePaymentStatus(input.paymentStatus, input.dueBy, input.now);
  if (!isPayable(status)) throw new ExecutionRuleError('CLEANING_NOTHING_TO_PAY');
  const missing = input.netAmount - input.balance;
  if (missing <= 0) return { kind: 'debit_wallet' };
  if (input.method === 'wallet') throw new ExecutionRuleError('CLEANING_INSUFFICIENT_BALANCE', { missing });
  const live = input.directPayments.find((payment) => isLivePage(payment, input.now));
  if (live) return { kind: 'existing_page', payment: live };
  if (input.directPayments.some((payment) => payment.status === 'succeeded' && !payment.debited)) {
    return { kind: 'awaiting_payment' };
  }
  return {
    kind: 'new_page',
    amount: missing,
    expiresAt: directPaymentExpiry(input.providerExpiry, input.dueBy, input.now),
  };
}

/** Cause d'un objet qui n'est plus payable (événement cleaning.direct_payment.left_in_wallet). */
export type NotPayableCause = 'request_closed' | 'already_paid' | 'waived' | 'cancelled';
export type Payability = { payable: true } | { payable: false; cause: NotPayableCause };

/**
 * Une séance se paie « à payer » ou « en retard ». Interprétation : une séance « non due » n'a jamais
 * eu de page de paiement, sauf annulée sans frais après coup ; elle est donc comptée « annulée ».
 */
export function sessionPayability(status: SessionPaymentStatus | null): Payability {
  if (isPayable(status)) return { payable: true };
  if (status === 'paid') return { payable: false, cause: 'already_paid' };
  if (status === 'waived') return { payable: false, cause: 'waived' };
  return { payable: false, cause: 'cancelled' };
}

/** À la réception du crédit visant l'objet : débit, ou montant laissé au wallet (tracé, client prévenu). */
export function settleDirectPayment(
  payability: Payability,
): { outcome: 'debit' } | { outcome: 'left_in_wallet'; cause: NotPayableCause } {
  return payability.payable ? { outcome: 'debit' } : { outcome: 'left_in_wallet', cause: payability.cause };
}
