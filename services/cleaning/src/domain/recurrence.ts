/**
 * Contrat récurrent (décision du 2026-10-21) : un nombre de passages par période (semaine ou
 * mois), pendant une durée en mois. Exemple : chaque jeudi pendant 3 mois = 1 passage par
 * semaine sur 3 mois. Chaque passage a sa propre équipe.
 */
export type RecurrencePeriod = 'week' | 'month';

export interface Recurrence {
  period: RecurrencePeriod;
  visitsPerPeriod: number;
  durationMonths: number;
}

const MAX_VISITS: Record<RecurrencePeriod, number> = { week: 7, month: 31 };
export const MAX_DURATION_MONTHS = 36;
/** Semaines par mois en moyenne (52 / 12). */
const WEEKS_PER_MONTH = 52 / 12;

export function isValidRecurrence(recurrence: Recurrence): boolean {
  const { period, visitsPerPeriod, durationMonths } = recurrence;
  return (
    (period === 'week' || period === 'month') &&
    Number.isInteger(visitsPerPeriod) &&
    visitsPerPeriod >= 1 &&
    visitsPerPeriod <= MAX_VISITS[period] &&
    Number.isInteger(durationMonths) &&
    durationMonths >= 1 &&
    durationMonths <= MAX_DURATION_MONTHS
  );
}

/** Nombre de passages prévus : 1 pour une prestation ponctuelle. */
export function plannedInterventions(recurrence: Recurrence | null): number {
  if (!recurrence) return 1;
  const periods =
    recurrence.period === 'week'
      ? Math.round(recurrence.durationMonths * WEEKS_PER_MONTH)
      : recurrence.durationMonths;
  return periods * recurrence.visitsPerPeriod;
}
