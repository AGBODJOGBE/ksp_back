import { sessionDebitKey, sessionDebitLabel } from './charge';
import {
  assertPaymentTransition,
  effectivePaymentStatus,
  isPayable,
  type SessionPaymentStatus,
} from './payment-status';

/**
 * Débit d'une séance de particulier sur son wallet (R-PP-01, R-PP-03, R-PP-04) : le wallet est
 * débité si son solde couvre le montant net ; sinon la séance attend son paiement (« à payer », puis
 * « en retard » après le délai de grâce). Le solde ne devient jamais négatif (R-WL-01).
 */
export interface DebitableSession {
  id: string;
  rank: number;
  sessionsCount: number;
  paymentStatus: SessionPaymentStatus | null;
  dueBy: Date | null;
  /** Montant dû moins les frais de visite déduits. */
  netAmount: number;
  /** Tentative en cours : 1, puis 2, 3… après un débit remboursé par le rapprochement (RV-80). */
  attempt: number;
}

export type DebitDecision =
  | { action: 'debit'; idempotencyKey: string; amount: number; label: string }
  | { action: 'await'; missing: number; status: 'due' | 'overdue' }
  | { action: 'none' };

export function debitDecision(session: DebitableSession, balance: number, now: Date): DebitDecision {
  const status = effectivePaymentStatus(session.paymentStatus, session.dueBy, now);
  if (!isPayable(status)) return { action: 'none' };
  if (balance >= session.netAmount) {
    return {
      action: 'debit',
      idempotencyKey: sessionDebitKey(session.id, session.attempt),
      amount: session.netAmount,
      label: sessionDebitLabel(session.rank, session.sessionsCount),
    };
  }
  return { action: 'await', missing: session.netAmount - balance, status: status as 'due' | 'overdue' };
}

/** RV-80 : un débit remboursé (WALLET_DEBIT_REFUNDED) se retente avec une clé numérotée. */
export function nextDebitAttempt(attempt: number): number {
  return attempt + 1;
}

/** Tâche du délai de grâce : enregistre le statut lu d'après l'heure (« en retard » à l'échéance). */
export function markOverdue(
  session: { paymentStatus: SessionPaymentStatus | null; dueBy: Date | null },
  now: Date,
): SessionPaymentStatus | null {
  return effectivePaymentStatus(session.paymentStatus, session.dueBy, now);
}

/**
 * Débit réussi : la séance est payée (facture émise au paiement, R-PP-06). `wasOverdue` : elle était
 * en retard, le programme est réévalué (R-PP-04, R-SU-01).
 */
export function recordDebitSucceeded(
  session: { paymentStatus: SessionPaymentStatus | null; dueBy: Date | null },
  now: Date,
): { paymentStatus: 'paid'; paidAt: Date; wasOverdue: boolean } {
  const status = effectivePaymentStatus(session.paymentStatus, session.dueBy, now) ?? 'not_due';
  assertPaymentTransition(status, 'paid');
  return { paymentStatus: 'paid', paidAt: now, wasOverdue: status === 'overdue' };
}

/** Séances en retard d'un programme, lues d'après l'heure (seuil de suspension, R-PP-04). */
export function countOverdue(
  sessions: ReadonlyArray<{ paymentStatus: SessionPaymentStatus | null; dueBy: Date | null }>,
  now: Date,
): number {
  return sessions.filter((line) => effectivePaymentStatus(line.paymentStatus, line.dueBy, now) === 'overdue')
    .length;
}
