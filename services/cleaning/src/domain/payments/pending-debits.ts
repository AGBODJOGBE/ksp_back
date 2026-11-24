import { effectivePaymentStatus, type SessionPaymentStatus } from './payment-status';

/**
 * RV-93 (R-FV-02, R-PP-03, R-PP-04) : toute recharge du wallet d'un titulaire (Mobile Money, espèces,
 * virement, remboursement), même sans objet visé, relance dans l'ordre les débits en attente que le
 * solde couvre : frais de visite, séances en retard, séances à payer, de la plus ancienne à la plus
 * récente.
 */
export type PendingDebitKind = 'visit_fee' | 'overdue_session' | 'due_session';

export interface PendingDebit {
  kind: PendingDebitKind;
  objectId: string;
  /** Montant à débiter (net des frais de visite déduits pour une séance). */
  amount: number;
  /** Date à laquelle le montant est devenu dû : ordre d'ancienneté. */
  since: Date;
}

const KIND_ORDER: Readonly<Record<PendingDebitKind, number>> = {
  visit_fee: 0,
  overdue_session: 1,
  due_session: 2,
};

export function relaunchOrder(pending: readonly PendingDebit[]): PendingDebit[] {
  return [...pending].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.since.getTime() - b.since.getTime() ||
      a.objectId.localeCompare(b.objectId),
  );
}

/**
 * Interprétation de « les débits en attente que le solde couvre » : on suit l'ordre, chaque débit
 * couvert par le solde restant est fait ; un débit trop grand est passé, sans bloquer les suivants.
 */
export function debitsToRelaunch(balance: number, pending: readonly PendingDebit[]): PendingDebit[] {
  let remaining = balance;
  const chosen: PendingDebit[] = [];
  for (const debit of relaunchOrder(pending)) {
    if (debit.amount > remaining) continue;
    chosen.push(debit);
    remaining -= debit.amount;
  }
  return chosen;
}

/** Nature d'une séance en attente de débit, d'après son statut lu à l'heure ; null : rien à relancer. */
export function sessionPendingKind(
  status: SessionPaymentStatus | null,
  dueBy: Date | null,
  now: Date,
): 'overdue_session' | 'due_session' | null {
  const effective = effectivePaymentStatus(status, dueBy, now);
  if (effective === 'overdue') return 'overdue_session';
  return effective === 'due' ? 'due_session' : null;
}
