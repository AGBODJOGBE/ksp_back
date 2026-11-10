import { type Recurrence } from './recurrence';
import { localDay } from './schedule';

/**
 * Plan de passages (ADR-052) : il remplace la récurrence approximative (ADR-023). Le moteur en tire
 * la liste exacte des dates ; le nombre de passages, donc le prix, est celui de cette liste.
 *
 * - `dates` : liste explicite de jours (prestation ponctuelle ou passages libres) ;
 * - `weekly` : jours de semaine, toutes les `everyWeeks` semaines, entre `startDate` et `endDate` ;
 * - `monthly` : chaque mois de la période, soit des jours du mois (`monthDays`, un jour absent du
 *   mois devient son dernier jour), soit des jours de semaine à des rangs (`weekdays` + `weeksOfMonth`,
 *   par exemple 1er et 3e lundi, ou dernier vendredi).
 *
 * Commun : heure de début (`startTime`, heure locale du fuseau du service), jours exclus (fériés,
 * absences) et jours ajoutés. Dates civiles AAAA-MM-JJ, bornes incluses.
 */
export type ScheduleMode = 'dates' | 'weekly' | 'monthly';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type WeekOfMonth = 1 | 2 | 3 | 4 | 'last';

export const SCHEDULE_MODES: readonly ScheduleMode[] = ['dates', 'weekly', 'monthly'];
/** Lundi d'abord, comme la semaine au Bénin. */
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const WEEKS_OF_MONTH: readonly WeekOfMonth[] = [1, 2, 3, 4, 'last'];

export interface InterventionSchedule {
  mode: ScheduleMode;
  /** Mode `dates` seulement. */
  dates: string[];
  /** Modes `weekly` et `monthly` : début et fin de la période, inclus ; null en mode `dates`. */
  startDate: string | null;
  endDate: string | null;
  /** `weekly`, ou `monthly` avec `weeksOfMonth`. */
  weekdays: Weekday[];
  /** `weekly` : 1 chaque semaine, 2 une semaine sur deux… ; 1 dans les autres modes. */
  everyWeeks: number;
  /** `monthly`, première forme : jours du mois (1 à 31). */
  monthDays: number[];
  /** `monthly`, seconde forme : rangs du jour de semaine dans le mois. */
  weeksOfMonth: WeekOfMonth[];
  /** Heure de début de chaque passage, HH:mm, heure locale. */
  startTime: string;
  excludedDates: string[];
  extraDates: string[];
}

/** Bornes réglables par configuration (CLEANING_SCHEDULE_MAX_MONTHS, CLEANING_SCHEDULE_MAX_VISITS). */
export interface SchedulePolicy {
  /** La période couvre au plus N mois : fin strictement avant le début + N mois. */
  maxMonths: number;
  maxVisits: number;
  /** Passages planifiés au plus par appel de planification en lot (CLEANING_SCHEDULE_MAX_BATCH). */
  maxBatch: number;
}

export const DEFAULT_SCHEDULE_POLICY: SchedulePolicy = { maxMonths: 36, maxVisits: 400, maxBatch: 400 };
export const MAX_EVERY_WEEKS = 12;
export const MAX_EXCLUDED_DATES = 400;
export const MAX_EXTRA_DATES = 100;

export type ScheduleWarningCode =
  'moved_to_month_end' | 'excluded' | 'excluded_not_planned' | 'extra_already_planned';

export interface ScheduleWarning {
  code: ScheduleWarningCode;
  date: string;
  message: string;
}

export interface ScheduleExpansion {
  /** Dates des passages, triées, sans doublon. */
  dates: string[];
  warnings: ScheduleWarning[];
}

export interface ScheduleProblem {
  field: string;
  message: string;
}

// --- Jours civils : nombre de jours depuis le 1970-01-01, calculs en UTC ---------------------------

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Jour civil valide (2027-02-30 est refusé), sinon null. */
export function parseDay(value: string): number | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return time / DAY_MS;
}

export function formatDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = lundi … 6 = dimanche. */
function weekdayIndex(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Même jour N mois plus tard, ramené au dernier jour du mois s'il n'existe pas. */
function addMonths(day: number, months: number): number {
  const date = new Date(day * DAY_MS);
  const target = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  return Date.UTC(year, month, Math.min(date.getUTCDate(), daysInMonth(year, month))) / DAY_MS;
}

/** Nombre de mois commencés entre deux jours : le plus petit N tel que first + N mois > last. */
function monthsCovered(first: number, last: number): number {
  let months = 1;
  while (addMonths(first, months) <= last) months += 1;
  return months;
}

// --- Contrôles ------------------------------------------------------------------------------------

const problemOf = (field: string, message: string): ScheduleProblem => ({
  field: `schedule.${field}`,
  message,
});

function daysProblem(field: string, values: string[], max: number): ScheduleProblem | null {
  if (values.length > max) return problemOf(field, `${max} dates au plus.`);
  if (values.some((value) => parseDay(value) === null)) {
    return problemOf(field, 'Dates attendues au format AAAA-MM-JJ.');
  }
  return null;
}

function hasDuplicates(values: readonly unknown[]): boolean {
  return new Set(values).size !== values.length;
}

function weekdaysProblem(weekdays: Weekday[]): ScheduleProblem | null {
  if (!weekdays.length) return problemOf('weekdays', 'Choisissez au moins un jour de la semaine.');
  if (weekdays.some((day) => !WEEKDAYS.includes(day)) || hasDuplicates(weekdays)) {
    return problemOf('weekdays', 'Jours attendus parmi mon, tue, wed, thu, fri, sat, sun, sans doublon.');
  }
  return null;
}

/** Champs propres aux autres modes : refusés plutôt qu'ignorés, pour qu'une erreur d'envoi se voie. */
function unusedProblem(schedule: InterventionSchedule, fields: (keyof InterventionSchedule)[]) {
  for (const field of fields) {
    const value = schedule[field];
    const used = Array.isArray(value)
      ? value.length > 0
      : field === 'everyWeeks'
        ? value !== 1
        : value !== null;
    if (used) return problemOf(field, `Sans effet en mode ${schedule.mode} : à ne pas envoyer.`);
  }
  return null;
}

function periodProblem(
  schedule: InterventionSchedule,
  limits: Pick<SchedulePolicy, 'maxMonths' | 'maxVisits'>,
): ScheduleProblem | null {
  const start = schedule.startDate === null ? null : parseDay(schedule.startDate);
  if (start === null) return problemOf('startDate', 'Date de début obligatoire, au format AAAA-MM-JJ.');
  const end = schedule.endDate === null ? null : parseDay(schedule.endDate);
  if (end === null) return problemOf('endDate', 'Date de fin obligatoire, au format AAAA-MM-JJ.');
  if (end < start) return problemOf('endDate', 'La date de fin doit suivre la date de début.');
  if (end >= addMonths(start, limits.maxMonths)) {
    return problemOf('endDate', `La période couvre ${limits.maxMonths} mois au plus.`);
  }
  return null;
}

/**
 * Premier défaut du plan (champ et message), null s'il est valide. Le nombre de passages
 * (au moins un, au plus `maxVisits`) se contrôle après la génération des dates.
 */
export function scheduleProblem(
  schedule: InterventionSchedule,
  limits: Pick<SchedulePolicy, 'maxMonths' | 'maxVisits'>,
): ScheduleProblem | null {
  if (!SCHEDULE_MODES.includes(schedule.mode)) {
    return problemOf('mode', 'Mode attendu : dates, weekly ou monthly.');
  }
  if (!TIME_PATTERN.test(schedule.startTime)) {
    return problemOf('startTime', 'Heure de début attendue au format HH:mm (00:00 à 23:59).');
  }
  const lists =
    daysProblem('excludedDates', schedule.excludedDates, MAX_EXCLUDED_DATES) ??
    daysProblem('extraDates', schedule.extraDates, MAX_EXTRA_DATES);
  if (lists) return lists;

  if (schedule.mode === 'dates') {
    const unused = unusedProblem(schedule, [
      'startDate',
      'endDate',
      'weekdays',
      'everyWeeks',
      'monthDays',
      'weeksOfMonth',
    ]);
    if (unused) return unused;
    if (!schedule.dates.length) return problemOf('dates', 'Indiquez au moins une date.');
    const dates = daysProblem('dates', schedule.dates, limits.maxVisits);
    if (dates) return dates;
    const days = [...schedule.dates, ...schedule.extraDates].map((value) => parseDay(value) as number);
    if (Math.max(...days) >= addMonths(Math.min(...days), limits.maxMonths)) {
      return problemOf('dates', `Les dates couvrent ${limits.maxMonths} mois au plus.`);
    }
    return null;
  }

  const period = periodProblem(schedule, limits);
  if (period) return period;
  if (schedule.mode === 'weekly') {
    const unused = unusedProblem(schedule, ['dates', 'monthDays', 'weeksOfMonth']);
    if (unused) return unused;
    if (
      !Number.isInteger(schedule.everyWeeks) ||
      schedule.everyWeeks < 1 ||
      schedule.everyWeeks > MAX_EVERY_WEEKS
    ) {
      return problemOf('everyWeeks', `Rythme attendu : 1 à ${MAX_EVERY_WEEKS} semaines.`);
    }
    return weekdaysProblem(schedule.weekdays);
  }

  const unused = unusedProblem(schedule, ['dates', 'everyWeeks']);
  if (unused) return unused;
  const byMonthDay = schedule.monthDays.length > 0;
  const byWeekday = schedule.weekdays.length > 0 || schedule.weeksOfMonth.length > 0;
  if (byMonthDay === byWeekday) {
    return problemOf(
      'monthDays',
      'Indiquez soit des jours du mois (monthDays), soit des jours de semaine et leurs rangs (weekdays et weeksOfMonth).',
    );
  }
  if (byMonthDay) {
    const valid = schedule.monthDays.every((day) => Number.isInteger(day) && day >= 1 && day <= 31);
    if (!valid || hasDuplicates(schedule.monthDays)) {
      return problemOf('monthDays', 'Jours du mois attendus de 1 à 31, sans doublon.');
    }
    return null;
  }
  const weekdays = weekdaysProblem(schedule.weekdays);
  if (weekdays) return weekdays;
  if (!schedule.weeksOfMonth.length) {
    return problemOf('weeksOfMonth', 'Indiquez les rangs dans le mois : 1, 2, 3, 4 ou last.');
  }
  if (
    schedule.weeksOfMonth.some((rank) => !WEEKS_OF_MONTH.includes(rank)) ||
    hasDuplicates(schedule.weeksOfMonth)
  ) {
    return problemOf('weeksOfMonth', 'Rangs attendus parmi 1, 2, 3, 4 et last, sans doublon.');
  }
  return null;
}

// --- Génération -----------------------------------------------------------------------------------

function weeklyDays(schedule: InterventionSchedule, start: number, end: number): number[] {
  const wanted = new Set(schedule.weekdays.map((day) => WEEKDAYS.indexOf(day)));
  const firstMonday = start - weekdayIndex(start);
  const days: number[] = [];
  for (let day = start; day <= end; day += 1) {
    const week = Math.floor((day - firstMonday) / 7);
    if (week % schedule.everyWeeks === 0 && wanted.has(weekdayIndex(day))) days.push(day);
  }
  return days;
}

/** Jour du `rank`-ième (ou dernier) jour de semaine `weekday` du mois. */
function nthWeekday(year: number, month: number, weekday: number, rank: WeekOfMonth): number {
  if (rank === 'last') {
    const last = Date.UTC(year, month, daysInMonth(year, month)) / DAY_MS;
    return last - ((weekdayIndex(last) - weekday + 7) % 7);
  }
  const first = Date.UTC(year, month, 1) / DAY_MS;
  return first + ((weekday - weekdayIndex(first) + 7) % 7) + (rank - 1) * 7;
}

function monthlyDays(
  schedule: InterventionSchedule,
  start: number,
  end: number,
  warnings: ScheduleWarning[],
): number[] {
  const days: number[] = [];
  const startDate = new Date(start * DAY_MS);
  let year = startDate.getUTCFullYear();
  let month = startDate.getUTCMonth();
  while (Date.UTC(year, month, 1) / DAY_MS <= end) {
    const length = daysInMonth(year, month);
    if (schedule.monthDays.length) {
      for (const monthDay of [...schedule.monthDays].sort((a, b) => a - b)) {
        const day = Date.UTC(year, month, Math.min(monthDay, length)) / DAY_MS;
        if (day < start || day > end) continue;
        if (monthDay > length && !warnings.some((warning) => warning.date === formatDay(day))) {
          warnings.push({
            code: 'moved_to_month_end',
            date: formatDay(day),
            message: `Le ${monthDay} n'existe pas ce mois-ci : passage ramené au dernier jour du mois.`,
          });
        }
        days.push(day);
      }
    } else {
      for (const weekday of schedule.weekdays) {
        for (const rank of schedule.weeksOfMonth) {
          const day = nthWeekday(year, month, WEEKDAYS.indexOf(weekday), rank);
          if (day >= start && day <= end) days.push(day);
        }
      }
    }
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return days;
}

/**
 * Liste exacte des dates d'un plan valide (voir `scheduleProblem`) : dates du mode, moins les jours
 * exclus, plus les jours ajoutés (un jour exclu le reste même s'il est ajouté). Avertissements :
 * jour ramené à la fin du mois, jour exclu (prévu ou non), jour ajouté déjà prévu.
 */
export function expandSchedule(schedule: InterventionSchedule): ScheduleExpansion {
  const warnings: ScheduleWarning[] = [];
  let base: number[];
  if (schedule.mode === 'dates') {
    base = schedule.dates.map((value) => parseDay(value) as number);
  } else {
    const start = parseDay(schedule.startDate as string) as number;
    const end = parseDay(schedule.endDate as string) as number;
    base =
      schedule.mode === 'weekly'
        ? weeklyDays(schedule, start, end)
        : monthlyDays(schedule, start, end, warnings);
  }
  const planned = new Set(base);
  const excluded = new Set<number>();
  for (const value of schedule.excludedDates) {
    const day = parseDay(value) as number;
    if (excluded.has(day)) continue;
    excluded.add(day);
    warnings.push(
      planned.has(day)
        ? { code: 'excluded', date: value, message: 'Jour exclu : aucun passage ce jour-là.' }
        : {
            code: 'excluded_not_planned',
            date: value,
            message: "Jour exclu qui n'était pas prévu : sans effet.",
          },
    );
  }
  for (const value of schedule.extraDates) {
    const day = parseDay(value) as number;
    if (planned.has(day) && !excluded.has(day)) {
      warnings.push({
        code: 'extra_already_planned',
        date: value,
        message: 'Jour ajouté déjà prévu : sans effet.',
      });
    }
    planned.add(day);
  }
  const dates = [...planned]
    .filter((day) => !excluded.has(day))
    .sort((a, b) => a - b)
    .map(formatDay);
  return { dates, warnings };
}

// --- Heures ---------------------------------------------------------------------------------------

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
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Début d'un passage : le jour à l'heure de début, dans le fuseau du service. */
export function passageStart(day: string, startTime: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const [hours, minutes] = startTime.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, date, hours, minutes);
  const first = wall - offsetMinutes(new Date(wall), timeZone) * 60_000;
  return new Date(wall - offsetMinutes(new Date(first), timeZone) * 60_000);
}

/** Heure locale HH:mm d'un instant. */
export function localTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

// --- Ancien format (ADR-023) ----------------------------------------------------------------------

/**
 * Récurrence approximative déduite d'un plan, pour les anciens lecteurs (billing : durée du contrat ;
 * règle des impayés d'un particulier en récurrent) : null pour un seul passage. La durée est le
 * nombre de mois commencés entre le premier et le dernier passage.
 */
export function legacyRecurrenceOf(schedule: InterventionSchedule, dates: string[]): Recurrence | null {
  if (dates.length < 2) return null;
  const first = parseDay(dates[0] as string) as number;
  const last = parseDay(dates[dates.length - 1] as string) as number;
  const durationMonths = monthsCovered(first, last);
  if (schedule.mode === 'weekly') {
    return { period: 'week', visitsPerPeriod: schedule.weekdays.length, durationMonths };
  }
  const perMonth =
    schedule.mode === 'monthly'
      ? schedule.monthDays.length || schedule.weekdays.length * schedule.weeksOfMonth.length
      : Math.ceil(dates.length / durationMonths);
  return { period: 'month', visitsPerPeriod: Math.min(31, perMonth), durationMonths };
}

/**
 * Traduction d'une récurrence de l'ancien format en plan, quand elle est exacte : un passage par
 * semaine (le jour de semaine du premier créneau) ou par mois (son jour du mois), depuis le premier
 * créneau, pendant la durée. Sinon null : la récurrence reste approximative (ancien calcul).
 */
export function scheduleFromLegacy(
  recurrence: Recurrence,
  firstStart: Date,
  timeZone: string,
): InterventionSchedule | null {
  if (recurrence.visitsPerPeriod !== 1) return null;
  const startDate = localDay(firstStart, timeZone);
  const start = parseDay(startDate) as number;
  const base: InterventionSchedule = {
    mode: recurrence.period === 'week' ? 'weekly' : 'monthly',
    dates: [],
    startDate,
    endDate: formatDay(addMonths(start, recurrence.durationMonths) - 1),
    weekdays: [],
    everyWeeks: 1,
    monthDays: [],
    weeksOfMonth: [],
    startTime: localTime(firstStart, timeZone),
    excludedDates: [],
    extraDates: [],
  };
  return recurrence.period === 'week'
    ? { ...base, weekdays: [WEEKDAYS[weekdayIndex(start)] as Weekday] }
    : { ...base, monthDays: [Number(startDate.slice(8, 10))] };
}
