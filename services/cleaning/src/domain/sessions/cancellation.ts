import type { SessionCancelCause } from '../payments/charge';
import { isCancelledForNoAgent } from '../planning/staffing-alert';
import { addHours } from '../requests/time';
import { ExecutionRuleError, invalidTransition, requireReason } from './errors';
import { assertSessionTransition, type SessionStatus } from './session-status';

/**
 * Annulation d'une séance (partie 12, SES-01). La part due d'une annulation tardive (50 % par
 * défaut) est calculée par payments/charge.ts à partir de la cause.
 */
export const DEFAULT_FREE_CANCELLATION_HOURS = 24;

export interface CancellableSession {
  status: SessionStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
}

/** Valeurs du contrat SessionCancellation. */
export interface SessionCancellation {
  by: 'customer' | 'ksp';
  cause: SessionCancelCause;
  late: boolean;
  at: Date;
  reason: string | null;
  actorId: string | null;
}

export type CancelledSession = { status: 'cancelled'; cancellation: SessionCancellation };

/**
 * « Le client agit seul jusqu'à 24 h avant une séance ». Interprétation : borne incluse, comme pour
 * le changement de créneau d'une visite (R-VI-03) ; à 24 h pile, l'annulation est encore sans frais.
 */
export function isWithinFreePeriod(scheduledStart: Date, now: Date, freeCancellationHours: number): boolean {
  return now.getTime() <= addHours(scheduledStart, -freeCancellationHours).getTime();
}

/** Séances qui n'ont pas commencé, seules annulables par le client ou tardivement par le support. */
const NOT_STARTED: readonly SessionStatus[] = ['to_assign', 'assigned'];

/** Annulation par le client plus de 24 h avant : rien à payer. La séance gelée (suspendue) aussi. */
export function cancelSessionByCustomer(
  session: CancellableSession,
  input: { actorId: string; now: Date; freeCancellationHours: number },
): CancelledSession {
  if (![...NOT_STARTED, 'suspended'].includes(session.status))
    throw invalidTransition(session.status, 'cancelled');
  if (!isWithinFreePeriod(session.scheduledStart, input.now, input.freeCancellationHours)) {
    throw new ExecutionRuleError('CLEANING_CANCELLATION_TOO_LATE', {
      freeCancellationHours: input.freeCancellationHours,
    });
  }
  const cancellation: SessionCancellation = {
    by: 'customer',
    cause: 'customer',
    late: false,
    at: input.now,
    reason: null,
    actorId: input.actorId,
  };
  return { status: 'cancelled', cancellation };
}

/**
 * CancelSessionAsKsp. « ksp » : décision de KSP (aussi après un incident ou pendant une suspension),
 * rien à payer. « customer_late » : annulation du client moins de 24 h avant, via le support, part
 * du prix due. Interprétations prudentes : une annulation saisie par le support encore dans le délai
 * reste sans frais (cause « customer ») ; une séance démarrée, interrompue ou suspendue n'est jamais
 * annulée tardivement au compte du client.
 */
export function cancelSessionAsKsp(
  session: CancellableSession,
  input: {
    initiatedBy: 'ksp' | 'customer_late';
    reason: string;
    actorId: string;
    now: Date;
    freeCancellationHours: number;
  },
): CancelledSession {
  const reason = requireReason(input.reason);
  const base = { at: input.now, reason, actorId: input.actorId };
  if (input.initiatedBy === 'ksp') {
    assertSessionTransition(session.status, 'cancelled', 'staff');
    return { status: 'cancelled', cancellation: { ...base, by: 'ksp', cause: 'ksp', late: false } };
  }
  if (!NOT_STARTED.includes(session.status)) throw invalidTransition(session.status, 'cancelled');
  const late = !isWithinFreePeriod(session.scheduledStart, input.now, input.freeCancellationHours);
  const cause = late ? 'customer_late' : 'customer';
  return { status: 'cancelled', cancellation: { ...base, by: 'customer', cause, late } };
}

/**
 * SES-01 (R-PL-10) : une séance encore « à affecter » à l'heure de fin prévue est annulée par KSP,
 * cause `no_agent`, sans rien à payer ; null tant que ce n'est pas le cas.
 */
export function cancelForNoAgent(session: CancellableSession, now: Date): CancelledSession | null {
  if (!isCancelledForNoAgent(session, now)) return null;
  return {
    status: 'cancelled',
    cancellation: { by: 'ksp', cause: 'no_agent', late: false, at: now, reason: null, actorId: null },
  };
}
