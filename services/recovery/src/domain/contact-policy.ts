import { addDays, dayOfWeek, localDay, localInstant } from './calendar';

/**
 * Règles de contact du débiteur et du locataire en retard (partie 2, décision 6) : de 8 h à 19 h, du
 * lundi au samedi, heure du Bénin ; jamais auprès de l'employeur ni des voisins. Un message
 * automatique prévu hors de la plage attend le prochain instant permis ; un contact manuel hors plage
 * est refusé (`RECOVERY_CONTACT_OUTSIDE_HOURS`, avec le prochain instant permis).
 */
export interface ContactWindow {
  /** Heure locale de début, incluse, « HH:MM ». */
  start: string;
  /** Heure locale de fin, exclue, « HH:MM ». */
  end: string;
  /** Jours ISO permis : 1 = lundi … 7 = dimanche. */
  days: readonly number[];
}

/** Personnes qu'un chargé peut contacter pour un dossier. */
export type ContactRecipient =
  'debtor' | 'co_debtor' | 'guarantor' | 'representative' | 'employer' | 'neighbour';

const FORBIDDEN_RECIPIENTS: ReadonlySet<ContactRecipient> = new Set(['employer', 'neighbour']);
const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export function isAllowedRecipient(recipient: ContactRecipient): boolean {
  return !FORBIDDEN_RECIPIENTS.has(recipient);
}

/** Minutes depuis minuit d'une heure « HH:MM » ; NaN si le format est faux. */
function minutesOf(time: string): number {
  const match = TIME.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
}

/** Jour ISO d'un jour local : 1 = lundi … 7 = dimanche. */
function isoDay(day: string): number {
  return dayOfWeek(day) === 0 ? 7 : dayOfWeek(day);
}

/** Problèmes d'une plage de contact. Vide = valide. */
export function contactWindowProblems(window: ContactWindow): string[] {
  const problems: string[] = [];
  const start = minutesOf(window.start);
  const end = minutesOf(window.end);
  if (Number.isNaN(start) || Number.isNaN(end)) problems.push('heures au format HH:MM');
  else if (end <= start) problems.push('la fin suit le début');
  if (window.days.length === 0) problems.push('au moins un jour');
  else if (new Set(window.days).size !== window.days.length) problems.push('jours en double');
  else if (window.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    problems.push('jours ISO de 1 à 7');
  return problems;
}

export function isWithinContactWindow(instant: Date, window: ContactWindow): boolean {
  const day = localDay(instant);
  if (!window.days.includes(isoDay(day))) return false;
  const minutes = (instant.getTime() - localInstant(day, 0).getTime()) / 60_000;
  return minutes >= minutesOf(window.start) && minutes < minutesOf(window.end);
}

/** Premier instant permis à partir de `instant` (lui-même s'il est dans la plage). */
export function nextContactInstant(instant: Date, window: ContactWindow): Date {
  if (isWithinContactWindow(instant, window)) return instant;
  const start = minutesOf(window.start);
  let day = localDay(instant);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const opening = localInstant(day, 0, start);
    if (window.days.includes(isoDay(day)) && opening > instant) return opening;
    day = addDays(day, 1);
  }
  throw new RangeError('Plage de contact sans aucun jour permis');
}
