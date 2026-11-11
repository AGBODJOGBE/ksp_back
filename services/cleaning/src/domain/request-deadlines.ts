import {
  effectiveRequestStatus,
  type QuoteRequest,
  type RequestStatus,
  type SiteVisit,
} from './quote-request';

/**
 * Échéances des demandes (ADR-053), traitées par une tâche planifiée idempotente :
 * - un devis envoyé dont la validité est dépassée est enregistré « expiré » ;
 * - un rappel est envoyé N jours avant l'expiration (réglage, 0 = aucun rappel), une fois par devis ;
 * - une visite encore planifiée d'une demande close (refusée, annulée, déclinée, expirée) est annulée.
 */
const DAY_MS = 86_400_000;

/** Demandes closes dont la visite planifiée n'a plus lieu d'être. */
export const VISIT_CLOSING_STATUSES: readonly RequestStatus[] = [
  'rejected',
  'cancelled',
  'declined',
  'expired',
];

/** Événements par lot : 10 demandes au plus (limite des groupes, ADR-035). */
export const MAX_BATCH_SIZE = 10;

export function isQuoteToExpire(request: Pick<QuoteRequest, 'status' | 'quote'>, now: Date): boolean {
  return request.status === 'quote_sent' && request.quote !== null && request.quote.validUntil <= now;
}

/** Devis encore valide qui expire dans les `reminderDays` jours ; jamais avec 0. */
export function isQuoteToRemind(
  request: Pick<QuoteRequest, 'status' | 'quote'>,
  now: Date,
  reminderDays: number,
): boolean {
  if (reminderDays <= 0 || request.status !== 'quote_sent' || !request.quote) return false;
  const validUntil = request.quote.validUntil.getTime();
  return validUntil > now.getTime() && validUntil - reminderDays * DAY_MS <= now.getTime();
}

/** Début de la fenêtre de rappel : devis qui expirent au plus tard à cette date. */
export function reminderHorizon(now: Date, reminderDays: number): Date {
  return new Date(now.getTime() + reminderDays * DAY_MS);
}

/** Visite encore planifiée alors que sa demande est close. */
export function isStaleVisit(request: Pick<QuoteRequest, 'status' | 'visit'>): boolean {
  return request.visit?.status === 'scheduled' && VISIT_CLOSING_STATUSES.includes(request.status);
}

/**
 * Visite telle qu'elle s'affiche : celle d'une demande close (ou dont le devis a expiré) apparaît
 * annulée, avant même le passage de la tâche planifiée.
 */
export function effectiveVisit(
  request: Pick<QuoteRequest, 'status' | 'quote' | 'visit'>,
  now: Date,
): SiteVisit | null {
  const visit = request.visit;
  if (!visit || visit.status !== 'scheduled') return visit;
  const status = effectiveRequestStatus(request, now);
  return VISIT_CLOSING_STATUSES.includes(status) ? { ...visit, status: 'cancelled' } : visit;
}

/**
 * Lots d'un même client et d'un même groupe (une demande seule forme son lot), dans l'ordre reçu,
 * de 10 demandes au plus : un événement, donc un message, par lot.
 */
export function requestBatches<T extends Pick<QuoteRequest, 'id' | 'customerId' | 'groupId'>>(
  requests: readonly T[],
): T[][] {
  const byKey = new Map<string, T[]>();
  for (const request of requests) {
    const key = `${request.customerId}:${request.groupId ?? request.id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), request]);
  }
  return [...byKey.values()].flatMap((batch) => {
    const chunks: T[][] = [];
    for (let start = 0; start < batch.length; start += MAX_BATCH_SIZE) {
      chunks.push(batch.slice(start, start + MAX_BATCH_SIZE));
    }
    return chunks;
  });
}
