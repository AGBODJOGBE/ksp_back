/**
 * Durée de conservation des positions et des photos (R-DP-01, R-EX-07, réglage `retentionMonths`,
 * 12 mois par défaut). Le départ est toujours la clôture d'une demande, la fin ou l'annulation d'un
 * programme, ou l'archivage d'un lieu, jamais la dernière modification.
 */

/**
 * Date avant laquelle une clôture, une fin, une annulation ou un archivage date de plus de `months`
 * mois : N mois civils avant maintenant, à la même heure (UTC) ; le jour est ramené au dernier jour
 * du mois visé quand il n'existe pas (31 mars moins un mois : 28 ou 29 février).
 */
export function retentionCutoff(now: Date, months: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

/** Clés d'idempotence : gardées 7 jours (R-EX-05 : 72 h de hors connexion et une marge). */
export const IDEMPOTENCY_RETENTION_DAYS = 7;
const DAY_MS = 24 * 3_600_000;

/** Date avant laquelle une clé d'idempotence n'est plus rejouable. */
export function idempotencyCutoff(now: Date): Date {
  return new Date(now.getTime() - IDEMPOTENCY_RETENTION_DAYS * DAY_MS);
}
