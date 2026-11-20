import {
  type MonthWeekday,
  type PlanKind,
  previewPlan,
  type SchedulePlan,
  type SchedulePreview,
  type WeekRank,
  type Weekday,
} from '../../domain/schedule-plan/plan';
import { type CleaningDeps } from '../deps';
import { CleaningErrors } from '../shared/errors';

/**
 * Programme souhaité reçu du contrat (SchedulePlan), contrôlé puis développé en dates exactes par le
 * domaine (R-PG-01 à R-PG-04). Valeurs énumérées refusées ici (`invalid_type`) ; le plan entier est
 * contrôlé par le domaine. Aucune date : CLEANING_SCHEDULE_EMPTY ; au-delà des bornes des réglages :
 * CLEANING_SCHEDULE_LIMIT_EXCEEDED.
 */
export interface SchedulePlanInput {
  kind: string;
  startTime: string;
  dates: string[];
  weekdays: string[];
  everyWeeks?: number | undefined;
  monthDays: number[];
  monthWeekdays: { rank: string; weekday: string }[];
  startDate?: string | undefined;
  endDate?: string | undefined;
  durationWeeks?: number | undefined;
  durationMonths?: number | undefined;
  excludedDates: string[];
  addedDates: string[];
  excludeHolidays?: boolean | undefined;
}

const KINDS: readonly PlanKind[] = ['one_off', 'weekly', 'monthly'];
const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const RANKS: readonly WeekRank[] = ['first', 'second', 'third', 'fourth', 'last'];

export function toSchedulePlan(input: SchedulePlanInput): SchedulePlan {
  if (!KINDS.includes(input.kind as PlanKind))
    throw CleaningErrors.validation('schedule.kind', 'invalid_type');
  input.weekdays.forEach((weekday, index) => {
    if (!WEEKDAYS.includes(weekday as Weekday)) {
      throw CleaningErrors.validation(`schedule.weekdays[${index}]`, 'invalid_type');
    }
  });
  input.monthWeekdays.forEach((entry, index) => {
    if (!RANKS.includes(entry.rank as WeekRank) || !WEEKDAYS.includes(entry.weekday as Weekday)) {
      throw CleaningErrors.validation(`schedule.monthWeekdays[${index}]`, 'invalid_type');
    }
  });
  return {
    kind: input.kind as PlanKind,
    startTime: input.startTime,
    dates: [...input.dates],
    weekdays: input.weekdays as Weekday[],
    everyWeeks: input.everyWeeks ?? null,
    monthDays: [...input.monthDays],
    monthWeekdays: input.monthWeekdays as MonthWeekday[],
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    durationWeeks: input.durationWeeks ?? null,
    durationMonths: input.durationMonths ?? null,
    excludedDates: [...input.excludedDates],
    addedDates: [...input.addedDates],
    excludeHolidays: input.excludeHolidays ?? null,
  };
}

/** Liste exacte des dates, bornes des réglages (partie 16.1) et jours fériés retenus (R-PG-02). */
export async function previewSchedule(deps: CleaningDeps, plan: SchedulePlan): Promise<SchedulePreview> {
  const [settings, holidays] = await Promise.all([
    deps.settings.catalogSettings(),
    deps.holidays.listHolidays(),
  ]);
  const limits = { maxMonths: settings.programMaxMonths, maxSessions: settings.programMaxSessions };
  const result = previewPlan(plan, { limits, holidays });
  const first = result.problems[0];
  if (first?.field === 'schedule') {
    if (first.reason === 'required') throw CleaningErrors.scheduleEmpty();
    throw CleaningErrors.scheduleLimitExceeded(limits.maxMonths, limits.maxSessions);
  }
  if (first) throw CleaningErrors.validation(`schedule.${first.field}`, first.reason);
  return result.preview as SchedulePreview;
}
