import { isWholeAmount, percentOf } from './money';

/**
 * Paiement d'une mission (décision du 2026-10-21) : le client choisit acompte (30 % réglable)
 * ou totalité, avant ou après la mission, en espèces ou par Mobile Money. Le superviseur coche
 * les paiements manuels ; un paiement en ligne sera enregistré par le système (service payment).
 */
export type PaymentOption = 'deposit' | 'full';
export type PaymentTiming = 'before' | 'after';
export type PaymentMethod = 'cash' | 'mobile_money_offline' | 'mobile_money_online';
export type PaymentStatus = 'due' | 'deposit_received' | 'paid';

export const PAYMENT_OPTIONS: readonly PaymentOption[] = ['deposit', 'full'];
export const PAYMENT_TIMINGS: readonly PaymentTiming[] = ['before', 'after'];
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'mobile_money_offline',
  'mobile_money_online',
];
/** Moyens que le superviseur peut cocher lui-même. */
export const MANUAL_PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'mobile_money_offline'];

export interface PaymentPlan {
  option: PaymentOption;
  timing: PaymentTiming;
  method: PaymentMethod;
}

export interface PaymentRecord {
  id: string;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  recordedBy: string;
  recordedAt: Date;
}

export interface PaymentState {
  plan: PaymentPlan;
  total: number;
  depositPercent: number;
  /** Montant attendu avant d'être « acompte reçu » : l'acompte, ou la totalité. */
  depositAmount: number;
  payments: PaymentRecord[];
}

export function isValidPlan(plan: PaymentPlan): boolean {
  return (
    PAYMENT_OPTIONS.includes(plan.option) &&
    PAYMENT_TIMINGS.includes(plan.timing) &&
    PAYMENT_METHODS.includes(plan.method)
  );
}

export function newPaymentState(plan: PaymentPlan, total: number, depositPercent: number): PaymentState {
  const percent = plan.option === 'full' ? 100 : depositPercent;
  return { plan, total, depositPercent: percent, depositAmount: percentOf(total, percent), payments: [] };
}

export function paidAmount(state: Pick<PaymentState, 'payments'>): number {
  return state.payments.reduce((sum, payment) => sum + payment.amount, 0);
}

export function paymentStatus(state: PaymentState): PaymentStatus {
  const paid = paidAmount(state);
  if (paid >= state.total) return 'paid';
  if (state.plan.option === 'deposit' && state.depositAmount > 0 && paid >= state.depositAmount) {
    return 'deposit_received';
  }
  return 'due';
}

/** Raison du refus d'un paiement, ou null s'il est acceptable (jamais au-delà du reste dû). */
export function paymentRefusal(
  state: PaymentState,
  amount: number,
  method: PaymentMethod,
  manual: boolean,
): 'amount_invalid' | 'method_not_allowed' | 'exceeds_balance' | null {
  if (!isWholeAmount(amount) || amount === 0) return 'amount_invalid';
  if (manual && !MANUAL_PAYMENT_METHODS.includes(method)) return 'method_not_allowed';
  if (paidAmount(state) + amount > state.total) return 'exceeds_balance';
  return null;
}
