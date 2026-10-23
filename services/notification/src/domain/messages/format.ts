/**
 * Mise en forme des valeurs dans les messages en français. Montants : entiers en XOF, sans
 * division ; séparateur de milliers : espace insécable, pour un rendu identique partout.
 */
const NBSP = '\u00a0';

/** 150000 → « 150 000 FCFA ». */
export function formatXof(amount: number): string {
  const digits = String(Math.trunc(Math.abs(amount)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${amount < 0 ? '-' : ''}${grouped}${NBSP}FCFA`;
}

/** Fuseau des dates affichées : le Bénin (UTC+1, sans heure d'été). */
export const DEFAULT_TIME_ZONE = 'Africa/Porto-Novo';

/**
 * Date et heure en toutes lettres : « jeudi 29 octobre 2026 à 09:30 ».
 * Renvoie null si la valeur n'est pas une date ISO 8601 lisible.
 */
export function formatDateTime(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${day} à ${time}`;
}

/** Date seule : « 15 novembre 2026 ». */
export function formatDate(iso: string, timeZone: string = DEFAULT_TIME_ZONE): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

/** 90 → « 1 h 30 », 120 → « 2 h », 45 → « 45 min ». */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}${NBSP}min`;
  return rest === 0 ? `${hours}${NBSP}h` : `${hours}${NBSP}h${NBSP}${String(rest).padStart(2, '0')}`;
}
