import { invalidTransition } from '../sessions/errors';

/**
 * Statut de paiement d'une séance de particulier (valeurs du contrat Session.payment_status, partie
 * 15.2) ; null pour une entreprise, réglée par la facture mensuelle (partie 11.2).
 */
export const PAYMENT_STATUSES = ['not_due', 'due', 'paid', 'overdue', 'waived'] as const;
export type SessionPaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type PayerKind = 'individual' | 'organization';

const TRANSITIONS: Readonly<Record<SessionPaymentStatus, readonly SessionPaymentStatus[]>> = {
  not_due: ['due'],
  due: ['paid', 'overdue'],
  overdue: ['paid'],
  paid: [],
  waived: [],
};

export function canTransitionPayment(from: SessionPaymentStatus, to: SessionPaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: SessionPaymentStatus, to: SessionPaymentStatus): void {
  if (!canTransitionPayment(from, to)) throw invalidTransition(from, to);
}

/**
 * Interprétation : 15.2 cite `waived` (repasse gratuite) sans flèche ; c'est donc le statut de
 * création d'une repasse gratuite (R-RC-03), jamais l'issue d'une transition.
 */
export function initialPaymentStatus(input: {
  payerKind: PayerKind;
  isRedo: boolean;
}): SessionPaymentStatus | null {
  if (input.payerKind === 'organization') return null;
  return input.isRedo ? 'waived' : 'not_due';
}

/**
 * Statut lu d'après l'heure (R-PP-04, RV-14) : une séance « à payer » dont le délai de grâce est
 * écoulé est « en retard », dès l'instant même de l'échéance, avant même le passage de la tâche.
 */
export function effectivePaymentStatus(
  status: SessionPaymentStatus | null,
  dueBy: Date | null,
  now: Date,
): SessionPaymentStatus | null {
  if (status === 'due' && dueBy !== null && now.getTime() >= dueBy.getTime()) return 'overdue';
  return status;
}

/** Une séance se paie quand elle est « à payer » ou « en retard » (PaySession). */
export function isPayable(status: SessionPaymentStatus | null): boolean {
  return status === 'due' || status === 'overdue';
}
