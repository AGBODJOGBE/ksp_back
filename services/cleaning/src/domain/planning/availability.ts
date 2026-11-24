import { type AgendaEntry, occupiedPeriod } from './agenda';
import { isInForce, isUpcoming } from './assignment-status';
import { accepted, type Decision, planningError, refused } from './errors';
import {
  addDays,
  addMinutes,
  isoWeekMonday,
  localDayStart,
  localDaysTouched,
  localPosition,
  overlapMinutes,
  overlaps,
  type Period,
} from './time';

/**
 * Disponibilités d'un agent (partie 9.2) : modèle hebdomadaire, exceptions, charge maximale.
 */

/** Plage du modèle hebdomadaire, à l'heure de Porto-Novo (jour ISO 1 = lundi ; fin exclue, 1440 au plus). */
export interface WeeklyRange {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** Disponibilité exceptionnelle sur une date ou une période (R-DS-02). */
export interface ExtraAvailability extends Period {
  id: string;
}

/** Indisponibilité déclarée : congé, maladie, motif libre (R-DS-02). */
export interface DeclaredUnavailability extends Period {
  id: string;
  reason: 'leave' | 'sickness' | 'other';
}

export interface LoadLimits {
  maxHoursPerDay: number;
  maxHoursPerWeek: number;
}

export interface LoadExcess {
  scope: 'day' | 'week';
  /** Jour, ou lundi de la semaine ISO, à l'heure de Porto-Novo. */
  from: string;
  plannedMinutes: number;
  maximumMinutes: number;
}

function weeklyPeriods(day: string, weekly: readonly WeeklyRange[]): Period[] {
  const { weekday } = localPosition(addMinutes(localDayStart(day), 720));
  const midnight = localDayStart(day);
  return weekly
    .filter((range) => range.weekday === weekday)
    .map((range) => ({
      start: addMinutes(midnight, range.startMinute),
      end: addMinutes(midnight, range.endMinute),
    }));
}

/**
 * Contrôle « Disponibilité » (9.4) : la période tient dans les plages de l'agent ou ses
 * disponibilités exceptionnelles. Des plages contiguës (y compris de part et d'autre de minuit)
 * forment une seule plage.
 */
export function fitsAvailability(
  period: Period,
  weekly: readonly WeeklyRange[],
  extras: readonly ExtraAvailability[],
): boolean {
  const pieces = [...localDaysTouched(period).flatMap((day) => weeklyPeriods(day, weekly)), ...extras].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
  let covered = period.start;
  for (const piece of pieces) {
    if (piece.end <= covered) continue;
    if (piece.start > covered) return false;
    covered = piece.end;
    if (covered >= period.end) return true;
  }
  return false;
}

/** Indisponibilités déclarées qui chevauchent la période, dans l'ordre chronologique. */
export function overlappingUnavailabilities(
  period: Period,
  unavailabilities: readonly DeclaredUnavailability[],
): DeclaredUnavailability[] {
  return unavailabilities
    .filter((unavailability) => overlaps(unavailability, period))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * R-DS-04 : une indisponibilité qui chevauche la période occupée (trajet compris) d'affectations en
 * vigueur est refusée avec leur liste ; le superviseur peut la forcer, ce qui les désaffecte.
 */
export function checkUnavailabilityDeclaration(
  period: Period,
  agenda: readonly AgendaEntry[],
  force: boolean,
  now: Date,
): Decision<{ toUnassign: string[] }> {
  const hit = agenda
    .filter((entry) => isInForce(entry, now) && overlaps(occupiedPeriod(entry), period))
    .map((entry) => entry.assignmentId);
  if (hit.length && !force)
    return refused(planningError('CLEANING_UNAVAILABILITY_CONFLICT', { assignments: hit }));
  return accepted({ toUnassign: force ? hit : [] });
}

/**
 * R-DS-05 : un changement du modèle hebdomadaire qui retire une plage occupée par une affectation à
 * venir passe par le superviseur. Une affectation qui tenait déjà hors des plages (contrôle contourné)
 * n'est pas touchée par le changement.
 */
export function checkAvailabilityChange(input: {
  current: readonly WeeklyRange[];
  next: readonly WeeklyRange[];
  extras: readonly ExtraAvailability[];
  agenda: readonly AgendaEntry[];
  bySupervisor: boolean;
  now: Date;
}): Decision<{ toUnassign: string[] }> {
  const hit = input.agenda
    .filter((entry) => isUpcoming(entry, input.now))
    .filter((entry) => fitsAvailability(entry, input.current, input.extras))
    .filter((entry) => !fitsAvailability(entry, input.next, input.extras))
    .map((entry) => entry.assignmentId);
  if (hit.length && !input.bySupervisor) {
    return refused(planningError('CLEANING_AVAILABILITY_IN_USE', { assignments: hit }));
  }
  return accepted({ toUnassign: hit });
}

/**
 * Temps de travail d'une affectation pour la charge : la cible seule, sans le trajet. La partie 9.2
 * parle d'« heures par jour et par semaine » sans dire si le trajet compte.
 */
export function workedPeriod(entry: Pick<AgendaEntry, 'start' | 'end'>): Period {
  return { start: entry.start, end: entry.end };
}

/**
 * Contrôle « Charge » (R-DS-03) : heures prévues par jour et par semaine ISO (lundi à dimanche),
 * à l'heure de Porto-Novo, cible comprise. Le maximum est atteint sans être dépassé.
 */
export function loadExcesses(
  candidate: Period,
  agenda: readonly AgendaEntry[],
  limits: LoadLimits,
  now: Date,
): LoadExcess[] {
  const worked = agenda.filter((entry) => isInForce(entry, now)).map(workedPeriod);
  const planned = (window: Period) =>
    worked.reduce((sum, period) => sum + overlapMinutes(period, window), overlapMinutes(candidate, window));
  const days = localDaysTouched(candidate);
  const excesses: LoadExcess[] = [];
  for (const day of days) {
    const minutes = planned({ start: localDayStart(day), end: localDayStart(addDays(day, 1)) });
    if (minutes > limits.maxHoursPerDay * 60) {
      excesses.push({
        scope: 'day',
        from: day,
        plannedMinutes: minutes,
        maximumMinutes: limits.maxHoursPerDay * 60,
      });
    }
  }
  for (const monday of [...new Set(days.map(isoWeekMonday))]) {
    const minutes = planned({ start: localDayStart(monday), end: localDayStart(addDays(monday, 7)) });
    if (minutes > limits.maxHoursPerWeek * 60) {
      excesses.push({
        scope: 'week',
        from: monday,
        plannedMinutes: minutes,
        maximumMinutes: limits.maxHoursPerWeek * 60,
      });
    }
  }
  return excesses;
}
