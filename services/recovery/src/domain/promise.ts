import { addDays, type LocalDay } from './calendar';
import { isWholeAmount } from './money';
import { type Outcome, refusal, success } from './outcome';

/**
 * Promesse de paiement (R-PR-09 ; message `PromiseToPay` du contrat) : « je paie 50 000 FCFA le 30 »,
 * enregistrée avec sa date. Les paiements reçus depuis la promesse la tiennent ; non tenue, elle
 * déclenche une relance le lendemain. Une promesse en attente s'annule (dossier clos, échéancier signé).
 */
export type PromiseStatus = 'pending' | 'kept' | 'broken' | 'cancelled';

export interface PaymentPromise {
  amount: number;
  dueDate: LocalDay;
  status: PromiseStatus;
}

export function newPromise(amount: number, dueDate: LocalDay, today: LocalDay): Outcome<PaymentPromise> {
  if (!isWholeAmount(amount) || amount === 0) {
    return refusal('RECOVERY_INVALID_AMOUNT', 'Montant promis entier et positif');
  }
  if (dueDate < today) return refusal('RECOVERY_INVALID_AMOUNT', 'Une promesse porte sur un jour à venir');
  return success({ amount, dueDate, status: 'pending' });
}

/**
 * État d'une promesse en attente : tenue dès que les paiements reçus depuis atteignent le montant,
 * rompue le lendemain de la date sans ce montant.
 */
export function evaluatePromise(
  promise: PaymentPromise,
  paidSincePromise: number,
  today: LocalDay,
): PromiseStatus {
  if (promise.status !== 'pending') return promise.status;
  if (paidSincePromise >= promise.amount) return 'kept';
  return today > promise.dueDate ? 'broken' : 'pending';
}

export function cancelPromise(promise: PaymentPromise): Outcome<PaymentPromise> {
  if (promise.status !== 'pending') return refusal('RECOVERY_INVALID_TRANSITION', 'Promesse déjà soldée');
  return success({ ...promise, status: 'cancelled' });
}

/** Jour de la relance d'une promesse non tenue : le lendemain de la date promise. */
export function brokenPromiseFollowUpDay(promise: PaymentPromise): LocalDay {
  return addDays(promise.dueDate, 1);
}
