import { type CleaningEventType } from '@ksp/contracts';
import { paymentNote } from '../../domain/messages/cleaning.messages';
import { formatDate, formatDateTime, formatDuration, formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';

/**
 * Messages des 7 événements du Nettoyage déjà publiés (cahier des charges Nettoyage, partie 6).
 *
 * Destinataires : le client (customerId) et, pour les visites et les passages planifiés, les agents
 * affectés. Le superviseur n'est pas prévenu : aucun événement ne dit lequel (point à valider).
 *
 * Liens « Mon espace KSP » (chemins du portail à valider) :
 *   /mon-espace/nettoyage/demandes/<requestId> et /mon-espace/nettoyage/missions/<missionId>.
 */

function requestLink(context: RuleContext, requestId: string): string {
  return `${context.portalBaseUrl}/mon-espace/nettoyage/demandes/${encodeURIComponent(requestId)}`;
}

function missionLink(context: RuleContext, missionId: string): string {
  return `${context.portalBaseUrl}/mon-espace/nettoyage/missions/${encodeURIComponent(missionId)}`;
}

/** Date écrite en toutes lettres ; un événement à la date illisible est refusé (file d'erreurs). */
function dateTime(iso: string, context: RuleContext): string {
  const text = formatDateTime(iso, context.timeZone);
  if (!text) throw new Error(`date illisible dans l'événement : ${iso}`);
  return text;
}

function day(iso: string, context: RuleContext): string {
  const text = formatDate(iso, context.timeZone);
  if (!text) throw new Error(`date illisible dans l'événement : ${iso}`);
  return text;
}

function customer(
  userId: string,
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  return { userId, templateCode, variables: { ...variables, link }, link };
}

export const CLEANING_RULES: { readonly [T in CleaningEventType]: EventRule<T> } = {
  'cleaning.quote.requested': (event, context) => [
    customer(event.customerId, 'cleaning.quote_requested.customer', requestLink(context, event.requestId), {
      visit_required: String(event.visitRequired),
    }),
  ],

  'cleaning.visit.scheduled': (event, context) => {
    const date = dateTime(event.scheduledAt, context);
    return [
      customer(event.customerId, 'cleaning.visit_scheduled.customer', requestLink(context, event.requestId), {
        date,
      }),
      {
        userId: event.agentId,
        templateCode: 'cleaning.visit_scheduled.agent',
        variables: { date },
        link: null,
      },
    ];
  },

  'cleaning.quote.sent': (event, context) => [
    customer(event.customerId, 'cleaning.quote_sent.customer', requestLink(context, event.requestId), {
      total: formatXof(event.total.amount),
      valid_until: day(event.validUntil, context),
    }),
  ],

  'cleaning.booking.confirmed': (event, context) => [
    customer(event.customerId, 'cleaning.booking_confirmed.customer', missionLink(context, event.missionId), {
      total: formatXof(event.total.amount),
      planned_interventions: String(event.plannedInterventions),
      payment_note: paymentNote({
        ...event.paymentPlan,
        total: event.total.amount,
        deposit: event.depositAmount.amount,
      }),
    }),
  ],

  'cleaning.mission.scheduled': (event, context) => {
    const variables = {
      date: dateTime(event.scheduledStart, context),
      duration: formatDuration(event.durationMinutes),
    };
    return [
      customer(
        event.customerId,
        'cleaning.mission_scheduled.customer',
        missionLink(context, event.missionId),
        variables,
      ),
      ...[...new Set(event.agentIds)].map((agentId) => ({
        userId: agentId,
        templateCode: 'cleaning.mission_scheduled.agent',
        variables,
        link: null,
      })),
    ];
  },

  'cleaning.mission.completed': (event, context) => [
    customer(event.customerId, 'cleaning.mission_completed.customer', missionLink(context, event.missionId), {
      completed_interventions: String(event.completedInterventions),
      completed_on: day(event.completedAt, context),
    }),
  ],

  'cleaning.request.cancelled': (event, context) => [
    customer(
      event.customerId,
      'cleaning.request_cancelled.customer',
      event.missionId ? missionLink(context, event.missionId) : requestLink(context, event.requestId),
      {
        case: event.outcome === 'cancelled' ? `cancelled_by_${event.cancelledBy}` : event.outcome,
        scope: event.missionId ? 'mission' : 'request',
      },
    ),
  ],
};
