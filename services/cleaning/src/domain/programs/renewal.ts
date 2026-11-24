import { addDays, localPosition } from '../planning/time';

/**
 * Renouveler un programme (R-PG-07) et commander à nouveau (R-PG-08), UC-NT-18. Domaine pur : seules
 * les conditions et le besoin d'une nouvelle visite sont décidés ici ; la création de la demande et
 * du devis (tarifs du jour) suit les règles du lot C.
 */

/** R-PG-07 : la proposition de renouvellement s'ouvre 14 jours avant la fin du programme. */
export const RENEWAL_WINDOW_DAYS = 14;
/** Décision du 18/11/2026 : sans nouvelle visite si le dernier constat a moins de 12 mois. */
export const VISIT_VALIDITY_MONTHS = 12;

const DAY_MS = 86_400_000;

export interface RenewalProgram {
  status: 'confirmed' | 'in_progress' | 'suspended' | 'completed' | 'cancelled';
  planKind: 'one_off' | 'weekly' | 'monthly';
  /** Début de la dernière séance non annulée ; null si le programme n'en a aucune. */
  lastSessionStart: Date | null;
  /** Programme déjà créé par un renouvellement de celui-ci ; null sinon. */
  renewedBy: string | null;
}

/** Motif de CLEANING_RENEWAL_NOT_ALLOWED (details.reason). */
export type RenewalRefusal =
  | 'not_recurring'
  | 'not_one_off'
  | 'too_early'
  | 'program_closed'
  | 'program_suspended'
  | 'not_completed'
  | 'already_renewed';

export type RenewalDecision =
  { ok: true; value: { withVisit: boolean } } | { ok: false; reason: RenewalRefusal };

/**
 * Nouvelle visite nécessaire : aucun constat, ou constat de plus de 12 mois (12 mois pile : encore
 * valable).
 */
export function visitRequired(lastObservationAt: Date | null, now: Date): boolean {
  if (!lastObservationAt) return true;
  const limit = new Date(lastObservationAt);
  limit.setUTCMonth(limit.getUTCMonth() + VISIT_VALIDITY_MONTHS);
  return now > limit;
}

/**
 * R-PG-07 : programme récurrent, ni annulé ni suspendu, pas encore renouvelé, dans ses 14 derniers
 * jours (ou déjà terminé). Interprétation : la fin du programme est le début de sa dernière séance.
 */
export function renewProgram(
  program: RenewalProgram,
  now: Date,
  lastObservationAt: Date | null,
): RenewalDecision {
  if (program.planKind === 'one_off') return { ok: false, reason: 'not_recurring' };
  if (program.status === 'cancelled') return { ok: false, reason: 'program_closed' };
  if (program.status === 'suspended') return { ok: false, reason: 'program_suspended' };
  if (program.renewedBy) return { ok: false, reason: 'already_renewed' };
  const end = program.lastSessionStart;
  if (end && now.getTime() < end.getTime() - RENEWAL_WINDOW_DAYS * DAY_MS)
    return { ok: false, reason: 'too_early' };
  return { ok: true, value: { withVisit: visitRequired(lastObservationAt, now) } };
}

/** R-PG-08 : programme ponctuel terminé, recommandé pour le même lieu. */
export function reorderProgram(
  program: RenewalProgram,
  now: Date,
  lastObservationAt: Date | null,
): RenewalDecision {
  if (program.planKind !== 'one_off') return { ok: false, reason: 'not_one_off' };
  if (program.status !== 'completed') return { ok: false, reason: 'not_completed' };
  return { ok: true, value: { withVisit: visitRequired(lastObservationAt, now) } };
}

/** Début du programme renouvelé (AAAA-MM-JJ) : la date demandée, sinon le lendemain de la dernière séance. */
export function renewalStartDate(lastSessionStart: Date, requested: string | null): string {
  return requested ?? addDays(localPosition(lastSessionStart).day, 1);
}
