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
