const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Décalage du fuseau par rapport à UTC à un instant donné, en millisecondes. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const local = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return local - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Début du jour civil AAAA-MM-JJ dans le fuseau donné, en UTC ; null si la date est mal formée ou
 * n'existe pas (2026-02-30). Exemple au Bénin (UTC+1) : 2026-11-05 → 2026-11-04T23:00:00Z.
 */
export function dayStart(value: string, timeZone: string): Date | null {
  const match = DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return new Date(utc - offsetMs(date, timeZone));
}

/** Début du jour suivant (borne exclue d'une période qui inclut ce jour). */
export function nextDayStart(value: string, timeZone: string): Date | null {
  const start = dayStart(value, timeZone);
  if (!start) return null;
  const match = DATE.exec(value)!;
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return dayStart(next.toISOString().slice(0, 10), timeZone);
}
