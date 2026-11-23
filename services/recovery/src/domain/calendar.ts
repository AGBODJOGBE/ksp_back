/**
 * Jours et heures du Bénin. Les échéances, délais et jours fériés se raisonnent en jours civils
 * locaux (`AAAA-MM-JJ`) ; le Bénin vit à UTC+1 toute l'année, sans heure d'été.
 */
export const BENIN_UTC_OFFSET_MINUTES = 60;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Jour civil local au format `AAAA-MM-JJ`. */
export type LocalDay = string;

/** Jour valide au format `AAAA-MM-JJ` (le 2026-02-30 est refusé). */
export function isLocalDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/** Jour local du Bénin d'un instant. */
export function localDay(instant: Date): LocalDay {
  return new Date(instant.getTime() + BENIN_UTC_OFFSET_MINUTES * MINUTE_MS).toISOString().slice(0, 10);
}

/** Instant correspondant à une heure locale du Bénin d'un jour donné. */
export function localInstant(day: LocalDay, hour: number, minute = 0): Date {
  return new Date(dayStartUtc(day) + (hour * 60 + minute - BENIN_UTC_OFFSET_MINUTES) * MINUTE_MS);
}

function dayStartUtc(day: LocalDay): number {
  if (!isLocalDay(day)) throw new RangeError(`Jour invalide : ${day}`);
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: LocalDay, days: number): LocalDay {
  return new Date(dayStartUtc(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Ajoute des mois en gardant le jour, ramené au dernier jour du mois si besoin (31 janv. + 1 → 28 ou 29 févr.). */
export function addMonths(day: LocalDay, months: number): LocalDay {
  const start = new Date(dayStartUtc(day));
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(start.getUTCDate(), lastDay))).toISOString().slice(0, 10);
}

/** Nombre de jours civils de `from` à `to` (négatif si `to` est avant). */
export function daysBetween(from: LocalDay, to: LocalDay): number {
  return Math.round((dayStartUtc(to) - dayStartUtc(from)) / DAY_MS);
}

/** Jour de la semaine : 0 = dimanche … 6 = samedi. */
export function dayOfWeek(day: LocalDay): number {
  return new Date(dayStartUtc(day)).getUTCDay();
}

/** Jour ouvré : du lundi au vendredi, hors jours fériés fournis par l'appelant (table réglable). */
export function isBusinessDay(day: LocalDay, holidays: ReadonlySet<LocalDay>): boolean {
  const weekday = dayOfWeek(day);
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

/** Ajoute N jours ouvrés : le jour de départ ne compte pas (départ un vendredi + 1 → lundi). */
export function addBusinessDays(day: LocalDay, count: number, holidays: ReadonlySet<LocalDay>): LocalDay {
  let current = day;
  let remaining = count;
  while (remaining > 0) {
    current = addDays(current, 1);
    if (isBusinessDay(current, holidays)) remaining -= 1;
  }
  return current;
}

/** Ajoute des jours civils à un instant (pas d'heure d'été au Bénin : 24 h par jour). */
export function addDaysToInstant(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}
