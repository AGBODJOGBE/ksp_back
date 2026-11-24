import { addDays } from '../planning/time';
import { type Holiday, MAX_EVERY_WEEKS, previewPlan, type SchedulePlan } from '../schedule-plan/plan';

/**
 * Plan d'un programme renouvelé (R-PG-07) : le même rythme (jours, heure, jours fériés), recalé à
 * partir d'une nouvelle date de début, pour le même nombre de séances. Interprétation : la période
 * du nouveau plan s'arrête le jour de sa dernière séance ; les jours exclus ou ajoutés à la main,
 * propres à l'ancienne période, ne sont pas repris.
 */

/** Bornes larges pour chercher les dates : le plan rendu est contrôlé avec les réglages du jour. */
const OPEN_LIMITS = { maxMonths: 1200, maxSessions: 100_000 };

export function renewedPlan(
  plan: SchedulePlan,
  startDate: string,
  count: number,
  holidays: readonly Holiday[],
): SchedulePlan | null {
  if (plan.kind === 'one_off' || !Number.isInteger(count) || count < 1) return null;
  const base: SchedulePlan = {
    ...plan,
    startDate,
    endDate: null,
    durationWeeks: null,
    durationMonths: null,
    excludedDates: [],
    addedDates: [],
  };
  // Périodes de plus en plus longues, jusqu'au rythme le plus lent qu'un plan permet.
  const horizons = [count * 7 + 14, count * 31 + 62, count * 7 * MAX_EVERY_WEEKS + 62];
  for (const days of horizons) {
    const result = previewPlan(
      { ...base, endDate: addDays(startDate, days) },
      { limits: OPEN_LIMITS, holidays },
    );
    const occurrences = result.preview?.occurrences ?? [];
    if (occurrences.length >= count) return { ...base, endDate: occurrences[count - 1]!.date };
    const empty = result.problems.length === 1 && result.problems[0]!.field === 'schedule';
    if (result.problems.length && !empty) return null;
  }
  return null;
}
