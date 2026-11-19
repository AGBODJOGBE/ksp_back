import { type CleaningEventPayloads } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';
import { eventDate as day, eventDateTime as dateTime } from './rule-dates';

/**
 * Messages des événements du Nettoyage, refonte v2 (ADR-054, cahier des charges Nettoyage v2,
 * partie 16.2).
 *
 * Seuls les six événements v1 réécrits sur place par la refonte gardent leur message, adapté aux
 * nouveaux champs (demande annulée, visite planifiée ou annulée, devis envoyé, rappel avant
 * l'expiration, devis expiré). Les messages des autres événements v2 (séances, programmes,
 * paiements, suspensions, réclamations, agents) et ceux du back-office (superviseur de la zone,
 * RV-62) seront écrits avec leurs lots (lot G, abonnements déclarés avec D40) ; d'ici là, ils ne
 * sont pas écoutés.
 *
 * Les événements v2 ne portent plus le nom d'une prestation (`service_name`, facultatif) : un devis
 * ou une visite est désigné par le numéro de son dossier (« dossier DN-000124 »).
 *
 * Destinataires : le client (customerId) ; les agents de la visite (planifiée) ou libérés (visite
 * annulée avec sa demande).
 *
 * Lien « Mon espace KSP » (chemin du portail à valider) : /mon-espace/nettoyage/demandes/<requestId>.
 */

function requestLink(context: RuleContext, requestId: string): string {
  return `${context.portalBaseUrl}/mon-espace/nettoyage/demandes/${encodeURIComponent(requestId)}`;
}

function customer(
  userId: string,
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  return { userId, templateCode, variables: { ...variables, link }, link };
}

/** Un message par agent, chacun une seule fois. */
function agents(
  agentIds: readonly string[],
  templateCode: string,
  variables: Record<string, string>,
): NotificationIntent[] {
  return [...new Set(agentIds)].map((userId) => ({ userId, templateCode, variables, link: null }));
}

/** « dossier DN-000124 ». */
function file(requestNumber: string): string {
  return `dossier ${requestNumber}`;
}

/** Devis cité par l'expiration ou son rappel : « du dossier DN-000124 (25 000 FCFA) ». */
function quoteOf(event: { requestNumber: string; total: { amount: number } }): string {
  return `du ${file(event.requestNumber)} (${formatXof(event.total.amount)})`;
}

/**
 * Motif de l'annulation d'une demande. `visit_fee_unpaid` : annulée par KSP, frais de visite non
 * payés à temps (R-FV-03) ; le message d'une annulation par KSP en tient lieu.
 */
const CANCELLATION_CASES: Readonly<
  Record<CleaningEventPayloads['cleaning.request.cancelled']['cause'], string>
> = {
  customer: 'cancelled_by_customer',
  visit_fee_unpaid: 'cancelled_by_supervisor',
};

/**
 * Causes d'une visite annulée avec sa demande, que l'agent apprend par le message « la demande a été
 * close ». Les autres (créneau changé, annulation par KSP, agent absent) attendent leur message v2.
 */
const CLOSED_REQUEST_CAUSES: ReadonlySet<string> = new Set(['request_cancelled', 'request_rejected']);

/** Événements v1 réécrits par la refonte, dont le message est gardé. */
type NotifiedCleaningEvent =
  | 'cleaning.request.cancelled'
  | 'cleaning.visit.scheduled'
  | 'cleaning.visit.cancelled'
  | 'cleaning.quote.sent'
  | 'cleaning.quote.expiry_reminded'
  | 'cleaning.quote.expired';

export const CLEANING_RULES: { readonly [T in NotifiedCleaningEvent]: EventRule<T> } = {
  'cleaning.request.cancelled': (event, context) => [
    customer(event.customerId, 'cleaning.request_cancelled.customer', requestLink(context, event.requestId), {
      case: CANCELLATION_CASES[event.cause],
      scope: 'request',
    }),
  ],

  // Visite planifiée ou déplacée : le client et chaque agent de la visite.
  'cleaning.visit.scheduled': (event, context) => {
    const date = dateTime(event.scheduledAt, context);
    return [
      customer(event.customerId, 'cleaning.visit_scheduled.customer', requestLink(context, event.requestId), {
        date,
      }),
      ...agents(event.agentIds, 'cleaning.visit_scheduled.agent', { date }),
    ];
  },

  // Visite annulée avec sa demande : les agents libérés ; le client est déjà prévenu de la clôture de
  // sa demande.
  'cleaning.visit.cancelled': (event, context) =>
    CLOSED_REQUEST_CAUSES.has(event.cause)
      ? agents(event.releasedAgentIds, 'cleaning.visit_cancelled.agent', {
          date: dateTime(event.scheduledAt, context),
          services: file(event.requestNumber),
        })
      : [],

  // Devis envoyé ou révisé.
  'cleaning.quote.sent': (event, context) => [
    customer(event.customerId, 'cleaning.quote_sent.customer', requestLink(context, event.requestId), {
      total: formatXof(event.total.amount),
      valid_until: day(event.validUntil, context),
    }),
  ],

  'cleaning.quote.expiry_reminded': (event, context) => [
    customer(
      event.customerId,
      'cleaning.quote_expiry_reminder.customer',
      requestLink(context, event.requestId),
      { quote_count: '1', quotes: quoteOf(event), valid_until: day(event.validUntil, context) },
    ),
  ],

  'cleaning.quote.expired': (event, context) => [
    customer(event.customerId, 'cleaning.quote_expired.customer', requestLink(context, event.requestId), {
      quote_count: '1',
      quotes: quoteOf(event),
    }),
  ],
};
