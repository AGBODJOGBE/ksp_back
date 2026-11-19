/**
 * Périodes et heure locale de la planification. Une période est semi-ouverte [début, fin), comme
 * la contrainte assignments_no_overlap : une affectation peut commencer à l'instant où la
 * précédente finit. Jours, plages hebdomadaires et charge se lisent à l'heure de Porto-Novo.
 */
export interface Period {
  start: Date;
  end: Date;
}

/** Fuseau des plages, des jours et des semaines (Africa/Porto-Novo, UTC+1 sans heure d'été). */
export const PLANNING_TIME_ZONE = 'Africa/Porto-Novo';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function overlaps(a: Period, b: Period): boolean {
  return a.start < b.end && b.start < a.end;
}

export function minutesBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MINUTE_MS;
}

export function overlapMinutes(a: Period, b: Period): number {
  const start = Math.max(a.start.getTime(), b.start.getTime());
  const end = Math.min(a.end.getTime(), b.end.getTime());
  return end > start ? (end - start) / MINUTE_MS : 0;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

const FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANNING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function localFields(date: Date): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const parts = Object.fromEntries(FORMAT.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Écart du fuseau à cet instant, en millisecondes (heure locale − UTC). */
function zoneOffsetMs(date: Date): number {
  const f = localFields(date);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Jour local (AAAA-MM-JJ), jour ISO (1 = lundi … 7 = dimanche) et minute depuis minuit local. */
export function localPosition(date: Date): { day: string; weekday: number; minute: number } {
  const f = localFields(date);
  const day = `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`;
  return { day, weekday: isoWeekday(day), minute: f.hour * 60 + f.minute };
}

/** Instant du minuit local qui ouvre ce jour. */
export function localDayStart(day: string): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  return new Date(guess - zoneOffsetMs(new Date(guess)));
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isoWeekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
}

/** Lundi de la semaine ISO du jour. */
export function isoWeekMonday(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

/** Jours locaux dont la période occupe au moins un instant, dans l'ordre. */
export function localDaysTouched(period: Period): string[] {
  const days: string[] = [];
  const last = localPosition(new Date(period.end.getTime() - 1)).day;
  for (let day = localPosition(period.start).day; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}
