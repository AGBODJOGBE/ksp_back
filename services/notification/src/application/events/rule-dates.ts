import { formatDate, formatDateTime } from '../../domain/messages/format';
import { type RuleContext } from './event-rules';

/**
 * Dates des événements écrites en toutes lettres, au fuseau des messages. Un événement à la date
 * illisible est refusé : l'erreur l'envoie en file d'erreurs après les reprises.
 */

export function eventDateTime(iso: string, context: RuleContext): string {
  const text = formatDateTime(iso, context.timeZone);
  if (!text) throw new Error(`date illisible dans l'événement : ${iso}`);
  return text;
}

export function eventDate(iso: string, context: RuleContext): string {
  const text = formatDate(iso, context.timeZone);
  if (!text) throw new Error(`date illisible dans l'événement : ${iso}`);
  return text;
}

/**
 * Jour civil AAAA-MM-JJ (champ `format: date` d'un événement : échéance, date d'un acte), écrit
 * tel quel, sans conversion de fuseau : « 2026-12-05 » donne « 5 décembre 2026 » quel que soit
 * le fuseau des messages. Un jour inexistant (2026-02-30) est refusé.
 */
export function eventCalendarDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !date || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`date illisible dans l'événement : ${value}`);
  }
  return formatDate(date.toISOString(), 'UTC') ?? value;
}
