/**
 * Plan de séances d'un programme (partie 8, R-PG-01 à R-PG-04, R-PG-09) : ponctuel, hebdomadaire
 * ou mensuel. Le moteur contrôle le plan, puis en tire la liste exacte des dates : le nombre de
 * séances, donc le prix du programme, est celui de cette liste. Jours civils AAAA-MM-JJ, bornes
 * incluses, heure de début dans le fuseau du service (Africa/Porto-Novo).
 */
export type PlanKind = 'one_off' | 'weekly' | 'monthly';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type WeekRank = 'first' | 'second' | 'third' | 'fourth' | 'last';

export interface MonthWeekday {
  rank: WeekRank;
  weekday: Weekday;
}

/** Programme souhaité ; un champ absent vaut null ou une liste vide. */
export interface SchedulePlan {
  kind: PlanKind;
  /** HH:MM, heure de Porto-Novo. */
  startTime: string;
  /** Ponctuel : jours de passage. */
  dates: string[];
  /** Hebdomadaire : jours de la semaine. */
  weekdays: Weekday[];
  /** Hebdomadaire : toutes les N semaines (1 à 12) ; null : chaque semaine. */
  everyWeeks: number | null;
  /** Mensuel : jours du mois (1 à 31). */
  monthDays: number[];
  /** Mensuel : jours de semaine à un rang. */
  monthWeekdays: MonthWeekday[];
  /** Récurrent : début, puis une seule forme de fin. */
  startDate: string | null;
  endDate: string | null;
  durationWeeks: number | null;
  durationMonths: number | null;
  excludedDates: string[];
  addedDates: string[];
  /** Exclure les jours fériés nationaux ; null : proposé par défaut (R-PG-02). */
  excludeHolidays: boolean | null;
}

export interface Holiday {
  date: string;
  name: string;
}

/** Réglages (16.1) : durée maximale en mois (1 à 60) et nombre maximal de séances (1 à 1000). */
export interface PlanLimits {
  maxMonths: number;
  maxSessions: number;
}

export interface PreviewOptions {
  limits: PlanLimits;
  holidays: readonly Holiday[];
  /** Fuseau des heures de début ; par défaut Africa/Porto-Novo (R-PG-01). */
  timeZone?: string;
}

export type PlanProblemReason = 'required' | 'not_applicable' | 'invalid_type' | 'out_of_range' | 'duplicate';

export interface PlanProblem {
  /** Champ du plan ; `schedule` pour le plan entier (nombre de séances, étendue des dates). */
  field: string;
  reason: PlanProblemReason;
}

export type ScheduleNoticeCode =
  | 'month_day_adjusted'
  | 'holiday_excluded'
  | 'date_excluded'
  | 'date_added'
  | 'excluded_not_planned'
  | 'added_already_planned';

export interface ScheduleNotice {
  code: ScheduleNoticeCode;
  date: string;
  /** Nom du jour férié, le cas échéant. */
  label: string | null;
}

export interface ScheduledOccurrence {
  date: string;
  start: Date;
}

export interface SchedulePreview {
  occurrences: ScheduledOccurrence[];
  count: number;
  firstStart: Date | null;
  lastStart: Date | null;
  notices: ScheduleNotice[];
}

export interface PlanResult {
  problems: PlanProblem[];
  /** Null tant que le plan a un défaut. */
  preview: SchedulePreview | null;
}

export const DEFAULT_TIME_ZONE = 'Africa/Porto-Novo';
export const MAX_EVERY_WEEKS = 12;
export const MAX_DURATION_WEEKS = 260;
export const MAX_DURATION_MONTHS = 60;

/** Lundi d'abord. */
const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const RANKS: readonly WeekRank[] = ['first', 'second', 'third', 'fourth'];

// --- Jours civils : nombre de jours depuis le 1970-01-01, calculs en UTC ----------------------------

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Jour civil valide (2027-02-30 est refusé), sinon null. */
function parseDay(value: string): number | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return date.getTime() / DAY_MS;
}

const formatDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** 0 = lundi … 6 = dimanche. */
const weekdayIndex = (day: number) => (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const dayOf = (year: number, month: number, date: number) => Date.UTC(year, month, date) / DAY_MS;

/** Même jour N mois plus tard, ramené au dernier jour du mois s'il n'existe pas. */
function addMonths(day: number, months: number): number {
  const date = new Date(day * DAY_MS);
  const target = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(target / 12);
  const month = target % 12;
  return dayOf(year, month, Math.min(date.getUTCDate(), daysInMonth(year, month)));
}

// --- Contrôles (R-PG-09) ---------------------------------------------------------------------------

type PlanField = keyof SchedulePlan;

/** Champs propres à chaque type de plan, dans l'ordre des contrôles. */
const KIND_FIELDS: readonly PlanField[] = [
  'dates',
  'weekdays',
  'everyWeeks',
  'monthDays',
  'monthWeekdays',
  'startDate',
  'endDate',
  'durationWeeks',
  'durationMonths',
];
const FIELDS_OF: Record<PlanKind, readonly PlanField[]> = {
  one_off: ['dates'],
  weekly: ['weekdays', 'everyWeeks', 'startDate', 'endDate', 'durationWeeks', 'durationMonths'],
  monthly: ['monthDays', 'monthWeekdays', 'startDate', 'endDate', 'durationWeeks', 'durationMonths'],
};

const isSet = (value: unknown) => (Array.isArray(value) ? value.length > 0 : value !== null);
const inRange = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

function dayListProblems(field: string, values: readonly string[]): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (parseDay(value) === null) problems.push({ field: `${field}[${index}]`, reason: 'invalid_type' });
    else if (seen.has(value)) problems.push({ field: `${field}[${index}]`, reason: 'duplicate' });
    seen.add(value);
  });
  return problems;
}

/** Période d'un plan récurrent : début, puis une seule forme de fin, au plus `maxMonths` mois. */
function periodProblems(plan: SchedulePlan, limits: PlanLimits): PlanProblem[] {
  const ends = (['endDate', 'durationWeeks', 'durationMonths'] as const).filter(
    (field) => plan[field] !== null,
  );
  const problems: PlanProblem[] = ends.slice(1).map((field) => ({ field, reason: 'not_applicable' }));
  if (plan.startDate === null) problems.push({ field: 'startDate', reason: 'required' });
  else if (parseDay(plan.startDate) === null) problems.push({ field: 'startDate', reason: 'invalid_type' });
  const endField = ends[0];
  if (endField === undefined) problems.push({ field: 'endDate', reason: 'required' });
  if (problems.length || endField === undefined) return problems;

  const start = parseDay(plan.startDate as string) as number;
  const end = periodEnd(plan, start);
  if (end === null)
    return [{ field: endField, reason: endField === 'endDate' ? 'invalid_type' : 'out_of_range' }];
  if (end < start || end >= addMonths(start, limits.maxMonths))
    return [{ field: endField, reason: 'out_of_range' }];
  return [];
}

/**
 * Dernier jour de la période. Durée de N mois : début + N mois − 1 jour (R-PG-09), le jour du mois
 * étant ramené à la fin d'un mois plus court (31 janvier + 1 mois − 1 jour = 27 février). Durée de
 * N semaines : début + 7 × N − 1 jours (interprétation, par analogie avec la durée en mois).
 */
function periodEnd(plan: SchedulePlan, start: number): number | null {
  if (plan.endDate !== null) return parseDay(plan.endDate);
  if (plan.durationWeeks !== null) {
    return inRange(plan.durationWeeks, 1, MAX_DURATION_WEEKS) ? start + 7 * plan.durationWeeks - 1 : null;
  }
  const months = plan.durationMonths as number;
  return inRange(months, 1, MAX_DURATION_MONTHS) ? addMonths(start, months) - 1 : null;
}

function patternProblems(plan: SchedulePlan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (plan.kind === 'one_off') {
    if (!plan.dates.length) problems.push({ field: 'dates', reason: 'required' });
    problems.push(...dayListProblems('dates', plan.dates));
  } else if (plan.kind === 'weekly') {
    if (!plan.weekdays.length) problems.push({ field: 'weekdays', reason: 'required' });
    if (plan.everyWeeks !== null && !inRange(plan.everyWeeks, 1, MAX_EVERY_WEEKS)) {
      problems.push({ field: 'everyWeeks', reason: 'out_of_range' });
    }
  } else if (plan.monthDays.length && plan.monthWeekdays.length) {
    problems.push({ field: 'monthWeekdays', reason: 'not_applicable' });
  } else if (!plan.monthDays.length && !plan.monthWeekdays.length) {
    problems.push({ field: 'monthDays', reason: 'required' });
  } else {
    plan.monthDays.forEach((day, index) => {
      if (!inRange(day, 1, 31)) problems.push({ field: `monthDays[${index}]`, reason: 'out_of_range' });
    });
  }
  return problems;
}

/** Défauts de structure du plan (R-PG-09), avant le calcul des dates. */
export function planProblems(plan: SchedulePlan, limits: PlanLimits): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (!TIME_PATTERN.test(plan.startTime)) problems.push({ field: 'startTime', reason: 'invalid_type' });
  for (const field of KIND_FIELDS) {
    if (!FIELDS_OF[plan.kind].includes(field) && isSet(plan[field]))
      problems.push({ field, reason: 'not_applicable' });
  }
  if (problems.length) return problems;
  problems.push(...patternProblems(plan));
  if (plan.kind !== 'one_off') problems.push(...periodProblems(plan, limits));
  problems.push(...dayListProblems('excludedDates', plan.excludedDates));
  problems.push(...dayListProblems('addedDates', plan.addedDates));
  return problems;
}

// --- Génération des dates ----------------------------------------------------------------------------

/** « Toutes les N semaines » se compte depuis le lundi de la semaine du début (R-PG-09). */
function weeklyDays(plan: SchedulePlan, start: number, end: number): number[] {
  const wanted = new Set(plan.weekdays.map((weekday) => WEEKDAYS.indexOf(weekday)));
  const every = plan.everyWeeks ?? 1;
  const firstMonday = start - weekdayIndex(start);
  const days: number[] = [];
  for (let day = start; day <= end; day += 1) {
    if (Math.floor((day - firstMonday) / 7) % every === 0 && wanted.has(weekdayIndex(day))) days.push(day);
  }
  return days;
}

/** Jour de semaine à un rang dans le mois ; « dernier » compte depuis la fin du mois. */
function rankedWeekday(year: number, month: number, entry: MonthWeekday): number {
  const weekday = WEEKDAYS.indexOf(entry.weekday);
  if (entry.rank === 'last') {
    const last = dayOf(year, month, daysInMonth(year, month));
    return last - ((weekdayIndex(last) - weekday + 7) % 7);
  }
  const first = dayOf(year, month, 1);
  return first + ((weekday - weekdayIndex(first) + 7) % 7) + RANKS.indexOf(entry.rank) * 7;
}

function monthlyDays(plan: SchedulePlan, start: number, end: number, notices: ScheduleNotice[]): number[] {
  const days: number[] = [];
  const first = new Date(start * DAY_MS);
  for (let index = 0; ; index += 1) {
    const year = first.getUTCFullYear() + Math.floor((first.getUTCMonth() + index) / 12);
    const month = (first.getUTCMonth() + index) % 12;
    if (dayOf(year, month, 1) > end) return days;
    const length = daysInMonth(year, month);
    for (const monthDay of plan.monthDays) {
      const day = dayOf(year, month, Math.min(monthDay, length));
      if (day < start || day > end) continue;
      if (monthDay > length && !notices.some((notice) => notice.date === formatDay(day))) {
        notices.push({ code: 'month_day_adjusted', date: formatDay(day), label: null });
      }
      days.push(day);
    }
    for (const entry of plan.monthWeekdays) {
      const day = rankedWeekday(year, month, entry);
      if (day >= start && day <= end) days.push(day);
    }
  }
}

/**
 * Jours fériés exclus : par défaut oui, l'exclusion étant « proposée automatiquement » (R-PG-02) ;
 * le client la désactive explicitement (interprétation prudente d'un champ absent).
 */
function holidaysExcluded(plan: SchedulePlan): boolean {
  return plan.excludeHolidays ?? true;
}

/**
 * Dates d'un plan sans défaut de structure : jours du plan, plus les jours ajoutés, moins les jours
 * exclus (un jour exclu le reste même ajouté) et les jours fériés (sauf ajoutés explicitement).
 */
function expand(
  plan: SchedulePlan,
  holidays: readonly Holiday[],
): { days: number[]; notices: ScheduleNotice[] } {
  const notices: ScheduleNotice[] = [];
  let base: number[];
  if (plan.kind === 'one_off') {
    base = plan.dates.map((value) => parseDay(value) as number);
  } else {
    const start = parseDay(plan.startDate as string) as number;
    const end = periodEnd(plan, start) as number;
    base = plan.kind === 'weekly' ? weeklyDays(plan, start, end) : monthlyDays(plan, start, end, notices);
  }
  const planned = new Set(base);
  const added = new Set(plan.addedDates.map((value) => parseDay(value) as number));
  const excluded = new Set(plan.excludedDates.map((value) => parseDay(value) as number));
  for (const day of excluded) {
    const wasPlanned = planned.has(day) || added.has(day);
    notices.push({
      code: wasPlanned ? 'date_excluded' : 'excluded_not_planned',
      date: formatDay(day),
      label: null,
    });
  }
  for (const day of added) {
    if (excluded.has(day)) continue;
    notices.push({
      code: planned.has(day) ? 'added_already_planned' : 'date_added',
      date: formatDay(day),
      label: null,
    });
  }
  const kept = new Set([...planned, ...added].filter((day) => !excluded.has(day)));
  if (holidaysExcluded(plan)) {
    for (const holiday of holidays) {
      const day = parseDay(holiday.date);
      if (day === null || !kept.has(day) || added.has(day)) continue;
      kept.delete(day);
      notices.push({ code: 'holiday_excluded', date: holiday.date, label: holiday.name });
    }
  }
  return { days: [...kept].sort((a, b) => a - b), notices };
}

// --- Heures ------------------------------------------------------------------------------------------

/** Décalage du fuseau à un instant, en minutes (heure locale − UTC). */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
  const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  return Math.round((local - at.getTime()) / 60_000);
}

/** Début d'une séance : le jour à l'heure de début, dans le fuseau donné. */
function sessionStart(day: number, startTime: string, timeZone: string): Date {
  const [hours, minutes] = startTime.split(':').map(Number) as [number, number];
  const wall = day * DAY_MS + (hours * 60 + minutes) * 60_000;
  const first = wall - offsetMinutes(new Date(wall), timeZone) * 60_000;
  return new Date(wall - offsetMinutes(new Date(first), timeZone) * 60_000);
}

// --- Aperçu ------------------------------------------------------------------------------------------

/**
 * Liste exacte des dates d'un plan et leur nombre (R-PG-04). Bornes (R-PG-03) : au moins une
 * séance, au plus `maxSessions`, et toutes les dates dans moins de `maxMonths` mois depuis la
 * première.
 */
export function previewPlan(plan: SchedulePlan, options: PreviewOptions): PlanResult {
  const problems = planProblems(plan, options.limits);
  if (problems.length) return { problems, preview: null };
  const { days, notices } = expand(plan, options.holidays);
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) {
    return { problems: [{ field: 'schedule', reason: 'required' }], preview: null };
  }
  if (days.length > options.limits.maxSessions || last >= addMonths(first, options.limits.maxMonths)) {
    return { problems: [{ field: 'schedule', reason: 'out_of_range' }], preview: null };
  }
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const occurrences = days.map((day) => ({
    date: formatDay(day),
    start: sessionStart(day, plan.startTime, timeZone),
  }));
  return {
    problems: [],
    preview: {
      occurrences,
      count: occurrences.length,
      firstStart: (occurrences[0] as ScheduledOccurrence).start,
      lastStart: (occurrences[occurrences.length - 1] as ScheduledOccurrence).start,
      notices,
    },
  };
}

/** Première séance au moins `leadHours` après maintenant (R-PG-03, R-DV-01). */
export function firstSessionRespectsLead(preview: SchedulePreview, now: Date, leadHours: number): boolean {
  return preview.firstStart !== null && preview.firstStart.getTime() - now.getTime() >= leadHours * 3_600_000;
}
