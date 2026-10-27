import { type CleaningEventType } from '@ksp/contracts';
import { paymentNote, unpaidText } from '../../domain/messages/cleaning.messages';
import { formatDate, formatDateTime, formatDuration, formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';

/**
 * Messages des événements du Nettoyage (cahier des charges Nettoyage, parties 6 et 10).
 *
 * Destinataires : le client (customerId) ; les agents affectés (visites, passages planifiés) ou
 * libérés (suspension) ; l'équipe Nettoyage configurée (NOTIFICATION_CLEANING_TEAM_USER_IDS) pour
 * la reprise après impayés et la reprogrammation à finir à la main, car ces événements ne désignent
 * ni l'admin ni le superviseur.
 *
 * Liens « Mon espace KSP » (chemins du portail à valider) : /mon-espace/nettoyage/demandes/<requestId>,
 * /mon-espace/nettoyage/missions/<missionId> et /mon-espace/factures.
 */

function requestLink(context: RuleContext, requestId: string): string {
  return `${context.portalBaseUrl}/mon-espace/nettoyage/demandes/${encodeURIComponent(requestId)}`;
}

function invoicesLink(context: RuleContext): string {
  return `${context.portalBaseUrl}/mon-espace/factures`;
}

/** Un message par membre de l'équipe Nettoyage configurée ; aucun si la liste est vide. */
function team(
  context: RuleContext,
  templateCode: string,
  variables: Record<string, string>,
): NotificationIntent[] {
  return context.cleaningTeamUserIds.map((userId) => ({ userId, templateCode, variables, link: null }));
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

  'cleaning.contract.suspension_warning': (event, context) => [
    customer(event.customerId, 'cleaning.suspension_warning.customer', invoicesLink(context), {
      unpaid_text: unpaidText('unpaid_invoices', event.unpaidCount),
      threshold: String(event.suspensionThreshold),
    }),
  ],

  'cleaning.contract.suspended': (event, context) => [
    customer(
      event.customerId,
      'cleaning.contract_suspended.customer',
      event.cause === 'unpaid_invoices' ? invoicesLink(context) : missionLink(context, event.missionId),
      { unpaid_text: unpaidText(event.cause, event.unpaidCount) },
    ),
    ...[...new Set(event.releasedAgentIds)].map((agentId) => ({
      userId: agentId,
      templateCode: 'cleaning.contract_suspended.agent',
      variables: {},
      link: null,
    })),
  ],

  'cleaning.contract.resumed': (event, context) => {
    const counts = {
      rescheduled_count: String(event.rescheduledCount),
      failed_count: String(event.failedCount),
    };
    return [
      customer(
        event.customerId,
        'cleaning.contract_resumed.customer',
        missionLink(context, event.missionId),
        counts,
      ),
      ...team(context, 'cleaning.contract_resumed.team', { ...counts, mission_id: event.missionId }),
    ];
  },

  'cleaning.rescheduling.failed': (event, context) =>
    team(context, 'cleaning.rescheduling_failed.team', {
      mission_id: event.missionId,
      failed_count: String(event.failedCount),
    }),
};
