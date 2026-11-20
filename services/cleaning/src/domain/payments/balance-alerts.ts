import { addDays } from '../planning/time';
import { localDay } from '../requests/time';
import type { SessionStatus } from '../sessions/session-status';
import type { PayerKind } from './payment-status';

/**
 * Rappel la veille d'une séance (partie 10, R-PP-05, RV-94) et alerte de solde insuffisant
 * (R-WL-06). Les jours se lisent à Porto-Novo. Le montant attendu d'une séance est son prix moins
 * les frais de visite qui lui restent à déduire (`expectedSessionAmount`).
 */
const PLANNED: readonly SessionStatus[] = ['to_assign', 'assigned'];

/**
 * Interprétation de « la veille » : le rappel part dès minuit la veille (Porto-Novo) ; si la tâche
 * n'est pas passée ce jour-là, il part encore le jour même tant que la séance n'a pas commencé. Une
 * seule fois par séance (`remindedAt`).
 */
export function isReminderDue(
  session: { status: SessionStatus; scheduledStart: Date; remindedAt: Date | null },
  now: Date,
): boolean {
  if (session.remindedAt !== null || !PLANNED.includes(session.status)) return false;
  if (now.getTime() >= session.scheduledStart.getTime()) return false;
  return localDay(now) >= addDays(localDay(session.scheduledStart), -1);
}

/** Contenu du rappel (cleaning.session.reminder) : montant et solde suffisant, null pour une entreprise. */
export function sessionReminder(input: {
  scheduledStart: Date;
  agentIds: readonly string[];
  payerKind: PayerKind;
  balance: number;
  expectedAmount: number;
  now: Date;
}) {
  const individual = input.payerKind === 'individual';
  return {
    scheduledStart: input.scheduledStart,
    agentIds: [...input.agentIds],
    amountDue: individual ? input.expectedAmount : null,
    balanceSufficient: individual ? input.balance >= input.expectedAmount : null,
    remindedAt: input.now,
  };
}

/**
 * R-WL-06 : quand une séance d'un particulier est affectée, ou après un débit, le client est alerté
 * si son solde ne couvre plus sa prochaine séance prévue ; une fois par séance et par jour.
 */
export function balanceAlert(input: {
  payerKind: PayerKind;
  balance: number;
  expectedAmount: number;
  lastAlertedAt: Date | null;
  trigger: 'assigned' | 'debit';
  guaranteeRequired: boolean;
  now: Date;
}) {
  if (input.payerKind !== 'individual' || input.balance >= input.expectedAmount) return null;
  if (input.lastAlertedAt !== null && localDay(input.lastAlertedAt) === localDay(input.now)) return null;
  return {
    amountDue: input.expectedAmount,
    missing: input.expectedAmount - input.balance,
    guaranteeRequired: input.guaranteeRequired,
    trigger: input.trigger,
    detectedAt: input.now,
  };
}

/** Prochaine séance prévue (à affecter ou planifiée) qui commence après maintenant. */
export function nextPlannedSession<T extends { status: SessionStatus; scheduledStart: Date }>(
  sessions: readonly T[],
  now: Date,
): T | null {
  const upcoming = sessions
    .filter((session) => PLANNED.includes(session.status) && session.scheduledStart.getTime() > now.getTime())
    .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
  return upcoming[0] ?? null;
}
