/**
 * Mise en forme française des valeurs imprimées : montants en FCFA entiers (jamais de division),
 * dates à l'heure du Bénin par défaut.
 */
const SPACE = ' ';

/** 150000 → « 150 000 FCFA » (espace fine insécable, comme l'écriture française des nombres). */
export function formatAmount(amount: number): string {
  const digits = Math.trunc(amount).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, SPACE);
  return `${grouped} FCFA`;
}

/** Pourcentage : 12.5 → « 12,5 % ». */
export function formatPercent(value: number): string {
  return `${String(value).replace('.', ',')}${SPACE}%`;
}

/**
 * Formateur réutilisé par fuseau : en créer un coûte environ 0,2 ms, soit 0,4 s pour les 2 000
 * horodatages d'un journal de preuve.
 */
function formatter(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let format = cache.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('fr-FR', { ...options, timeZone });
    cache.set(timeZone, format);
  }
  return format;
}
const LONG_DATES = new Map<string, Intl.DateTimeFormat>();
const DATE_TIMES = new Map<string, Intl.DateTimeFormat>();

/** Date seule écrite en toutes lettres : « 9 novembre 2026 ». */
export function formatLongDate(date: Date, timeZone: string): string {
  return formatter(LONG_DATES, timeZone, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** Date calendaire « AAAA-MM-JJ » (variable d'un modèle) écrite en toutes lettres. */
export function formatCalendarDate(value: string): string {
  return formatLongDate(new Date(`${value}T12:00:00Z`), 'UTC');
}

/** Date et heure à la seconde : « 09/11/2026 à 11:05:42 ». */
export function formatDateTime(date: Date, timeZone: string): string {
  const parts = formatter(DATE_TIMES, timeZone, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} à ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Ajoute des jours à une date (délai d'une mise en demeure). */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
