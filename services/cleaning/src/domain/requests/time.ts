/**
 * Heures du dossier. Le domaine ne lit jamais l'horloge : l'heure courante est toujours passée en
 * argument. Les instants sont en UTC ; les jours affichés et saisis sont ceux de Porto-Novo
 * (R-PG-01), UTC+1 toute l'année, sans heure d'été : un jour y dure toujours 24 h.
 */
export const TIME_ZONE = 'Africa/Porto-Novo';
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/**
 * Échéance atteinte : à l'instant même de l'échéance, le délai est écoulé (devis périmé à sa date
 * de validité, frais de visite impayés à leur limite de paiement « pay_before »).
 */
export function isPastDeadline(deadline: Date, now: Date): boolean {
  return now.getTime() >= deadline.getTime();
}

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Jour « AAAA-MM-JJ » de l'instant à Porto-Novo. */
export function localDay(date: Date): string {
  return DAY_FORMAT.format(date);
}
