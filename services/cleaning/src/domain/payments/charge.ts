import { percentOfBps } from '../pricing/money';
import { addHours } from '../requests/time';
import { allocateVisitFeeDeduction } from '../requests/visit-fee';
import { invalidTransition, validationFailed } from '../sessions/errors';
import type { MissedCause } from '../sessions/session';
import type { PayerKind, SessionPaymentStatus } from './payment-status';

/**
 * Montant dû après une séance (R-PP-01, R-PP-02, R-EX-02, partie 12) : le prix d'une séance
 * réalisée, une part du prix (50 % par défaut) d'une séance manquée par absence du client ou annulée
 * tard ; les frais de visite déjà payés se déduisent du premier montant dû, le reste des suivants.
 */
export const DEFAULT_LATE_FEE_PERCENT = 50;
export const DEFAULT_SESSION_PAYMENT_GRACE_HOURS = 24;

/** Cause d'une séance annulée (valeurs du contrat SessionCancellation.cause). */
export type SessionCancelCause = 'customer' | 'customer_late' | 'ksp' | 'no_agent' | 'program_stopped';

export type SessionOutcome =
  | { kind: 'completed' }
  | { kind: 'missed'; cause: MissedCause }
  | { kind: 'cancelled'; cause: SessionCancelCause };

/**
 * Interprétation prudente (« à valider : facturation d'un accès impossible » dans le contrat) : seule
 * l'absence du client est facturée ; un accès impossible n'est pas facturé tant que la règle manque.
 */
export function missedChargeApplies(cause: MissedCause): boolean {
  return cause === 'customer_absent';
}

/** Part du prix due, en pour cent (réglage « frais d'annulation tardive / de client absent »). */
export function chargePercent(outcome: SessionOutcome, lateFeePercent: number): number {
  if (outcome.kind === 'completed') return 100;
  if (outcome.kind === 'missed') return missedChargeApplies(outcome.cause) ? lateFeePercent : 0;
  return outcome.cause === 'customer_late' ? lateFeePercent : 0;
}

/** Montant dû, arrondi au franc, moitié vers le haut (même arrondi que le calcul du prix). */
export function amountDue(price: number, outcome: SessionOutcome, lateFeePercent: number): number {
  return percentOfBps(price, chargePercent(outcome, lateFeePercent) * 100);
}

/** Montant attendu d'une séance à venir : son prix moins les frais de visite qui lui restent à déduire. */
export function expectedSessionAmount(price: number, visitFeeToDeduct: number): number {
  return price - (allocateVisitFeeDeduction(visitFeeToDeduct, [price])[0] ?? 0);
}

export interface SessionCharge {
  amountDue: number;
  visitFeeDeduction: number;
  /** Montant à débiter du wallet : montant dû moins la déduction. */
  netAmount: number;
  paymentStatus: SessionPaymentStatus | null;
  /** Fin du délai de paiement (R-PP-03) ; null sans montant à payer. */
  dueBy: Date | null;
  /** Frais de visite qui restent à déduire des séances suivantes (Program.visitFeeToDeduct). */
  remainingVisitFeeToDeduct: number;
}

/**
 * Charge d'une séance close. Particulier : un montant dû la rend « à payer » sous le délai de grâce.
 * Interprétation : une séance entièrement couverte par les frais de visite est « payée » sans débit
 * (not_due → due → paid dans le même geste) ; sa facture est émise comme les autres.
 */
export function chargeSession(input: {
  price: number;
  outcome: SessionOutcome;
  payerKind: PayerKind;
  paymentStatus: SessionPaymentStatus | null;
  visitFeeToDeduct: number;
  lateFeePercent: number;
  graceHours: number;
  now: Date;
}): SessionCharge {
  if (input.paymentStatus === 'waived') {
    return {
      amountDue: 0,
      visitFeeDeduction: 0,
      netAmount: 0,
      paymentStatus: 'waived',
      dueBy: null,
      remainingVisitFeeToDeduct: input.visitFeeToDeduct,
    };
  }
  const due = amountDue(input.price, input.outcome, input.lateFeePercent);
  const deduction = allocateVisitFeeDeduction(input.visitFeeToDeduct, [due])[0] ?? 0;
  const net = due - deduction;
  const remaining = input.visitFeeToDeduct - deduction;
  const base = {
    amountDue: due,
    visitFeeDeduction: deduction,
    netAmount: net,
    remainingVisitFeeToDeduct: remaining,
  };
  if (input.payerKind === 'organization') return { ...base, paymentStatus: null, dueBy: null };
  const current = input.paymentStatus ?? 'not_due';
  if (current !== 'not_due') throw invalidTransition(current, 'due');
  if (due === 0) return { ...base, paymentStatus: 'not_due', dueBy: null };
  if (net === 0) return { ...base, paymentStatus: 'paid', dueBy: null };
  return { ...base, paymentStatus: 'due', dueBy: addHours(input.now, input.graceHours) };
}

/** R-PP-01 : `cleaning_session:<id>`, puis `cleaning_session:<id>:<n>` après un débit remboursé. */
export function sessionDebitKey(sessionId: string, attempt = 1): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw validationFailed('attempt', 'out_of_range');
  return attempt === 1 ? `cleaning_session:${sessionId}` : `cleaning_session:${sessionId}:${attempt}`;
}

/** R-WL-03 : objet lisible du débit. */
export function sessionDebitLabel(rank: number, sessionsCount: number): string {
  return `Nettoyage — séance ${rank}/${sessionsCount}`;
}

/** R-PP-06, RV-82 : facture de séance émise par billing au paiement, avec une clé fixe. */
export function sessionInvoiceDraft(input: {
  sessionId: string;
  rank: number;
  sessionsCount: number;
  amountDue: number;
  visitFeeDeduction: number;
}) {
  return {
    idempotencyKey: `cleaning_session_invoice:${input.sessionId}`,
    lines: [{ label: sessionDebitLabel(input.rank, input.sessionsCount), amount: input.amountDue }],
    visitFeeDeduction: input.visitFeeDeduction,
    total: input.amountDue - input.visitFeeDeduction,
  };
}
