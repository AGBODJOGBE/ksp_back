import { type CleaningEventType } from '@ksp/contracts';
import { enumeration, paymentNote, quotedService, unpaidText } from '../../domain/messages/cleaning.messages';
import { formatDuration, formatXof } from '../../domain/messages/format';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';
import { eventDate as day, eventDateTime as dateTime } from './rule-dates';

/**
 * Messages des événements du Nettoyage (cahier des charges Nettoyage, parties 6 et 10).
 *
 * Destinataires : le client (customerId) ; les agents affectés (visites, passages planifiés) ou
 * libérés (suspension) ; l'équipe Nettoyage configurée (NOTIFICATION_CLEANING_TEAM_USER_IDS) pour
 * la reprise après impayés et la reprogrammation à finir à la main, car ces événements ne désignent
 * ni l'admin ni le superviseur.
 *
 * Liens « Mon espace KSP » (chemins du portail à valider) : /mon-espace/nettoyage/demandes/<requestId>,
 * /mon-espace/nettoyage/demandes/groupes/<groupId>, /mon-espace/nettoyage/missions/<missionId> et
 * /mon-espace/factures.
 *
 * Messages regroupés (ADR-035 point 14) : un envoi groupé, une visite commune et un envoi groupé de
 * devis donnent un seul message, qui liste les prestations ; les événements par demande marqués
 * `summarizedByGroup` n'envoient alors rien (l'événement de groupe, publié dans la même
 * transaction, les couvre). Sans ce marqueur (demande seule, devis envoyé seul, événement
 * antérieur), un message par demande, avec le nom de la prestation quand il est connu.
 */

/** Cause de suspension propre à l'organisation cliente, suspendue par KSP (ADR-030). */
const ORGANIZATION_SUSPENDED = 'organization_suspended';

function requestLink(context: RuleContext, requestId: string): string {
  return `${context.portalBaseUrl}/mon-espace/nettoyage/demandes/${encodeURIComponent(requestId)}`;
}

function groupLink(context: RuleContext, groupId: string): string {
  return `${context.portalBaseUrl}/mon-espace/nettoyage/demandes/groupes/${encodeURIComponent(groupId)}`;
}

/** Nom de la prestation, quand l'événement le donne (variable facultative des modèles). */
function withService(serviceName: string | undefined): Record<string, string> {
  const name = serviceName?.trim();
  return name ? { service_name: name } : {};
}

/** « « Vitres », « Jardin » et « Bureaux » ». */
function serviceList(items: readonly { serviceName?: string | undefined }[]): string {
  return enumeration(items.map((item) => quotedService(item.serviceName)));
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

function customer(
  userId: string,
  templateCode: string,
  link: string,
  variables: Record<string, string>,
): NotificationIntent {
  return { userId, templateCode, variables: { ...variables, link }, link };
}

/**
 * Tous les événements du Nettoyage, sauf cleaning.mission.refunded (ADR-046) : le remboursement est
 * annoncé par wallet quand il est crédité (wallet.prepaid.credited).
 */
type NotifiedCleaningEvent = Exclude<CleaningEventType, 'cleaning.mission.refunded'>;

export const CLEANING_RULES: { readonly [T in NotifiedCleaningEvent]: EventRule<T> } = {
  'cleaning.quote.requested': (event, context) =>
    event.summarizedByGroup
      ? []
      : [
          customer(
            event.customerId,
            'cleaning.quote_requested.customer',
            requestLink(context, event.requestId),
            { visit_required: String(event.visitRequired), ...withService(event.serviceName) },
          ),
        ],

  // Envoi groupé : un message ; une seule prestation, le message d'une demande.
  'cleaning.quote_group.requested': (event, context) => {
    const visit_required = String(event.visitRequired);
    const [only, ...others] = event.requests;
    if (only && others.length === 0) {
      return [
        customer(
          event.customerId,
          'cleaning.quote_requested.customer',
          requestLink(context, only.requestId),
          {
            visit_required,
            ...withService(only.serviceName),
          },
        ),
      ];
    }
    return [
      customer(
        event.customerId,
        'cleaning.quote_group_requested.customer',
        groupLink(context, event.groupId),
        {
          visit_required,
          request_count: String(event.requests.length),
          services: serviceList(event.requests),
        },
      ),
    ];
  },

  'cleaning.visit.scheduled': (event, context) => {
    const date = dateTime(event.scheduledAt, context);
    // Visite commune à plusieurs demandes, prestations connues : un message qui les liste.
    const requests = event.groupVisitId ? (event.requests ?? []) : [];
    if (requests.length > 1) {
      const services = serviceList(requests);
      return [
        customer(
          event.customerId,
          'cleaning.group_visit_scheduled.customer',
          event.groupId ? groupLink(context, event.groupId) : requestLink(context, event.requestId),
          { date, services },
        ),
        {
          userId: event.agentId,
          templateCode: 'cleaning.group_visit_scheduled.agent',
          variables: { date, request_count: String(requests.length), services },
          link: null,
        },
      ];
    }
    const service = withService(requests[0]?.serviceName ?? event.serviceName);
    return [
      customer(event.customerId, 'cleaning.visit_scheduled.customer', requestLink(context, event.requestId), {
        date,
        ...service,
      }),
      {
        userId: event.agentId,
        templateCode: 'cleaning.visit_scheduled.agent',
        variables: { date, ...service },
        link: null,
      },
    ];
  },

  'cleaning.quote.sent': (event, context) =>
    event.summarizedByGroup
      ? []
      : [
          customer(event.customerId, 'cleaning.quote_sent.customer', requestLink(context, event.requestId), {
            total: formatXof(event.total.amount),
            valid_until: day(event.validUntil, context),
            ...withService(event.serviceName),
          }),
        ],

  // Devis du groupe envoyés ensemble : un message ; un seul devis, le message d'une demande.
  'cleaning.quote_group.sent': (event, context) => {
    const valid_until = day(event.validUntil, context);
    const [only, ...others] = event.quotes;
    if (only && others.length === 0) {
      return [
        customer(event.customerId, 'cleaning.quote_sent.customer', requestLink(context, only.requestId), {
          total: formatXof(only.total.amount),
          valid_until,
          ...withService(only.serviceName),
        }),
      ];
    }
    return [
      customer(event.customerId, 'cleaning.quote_group_sent.customer', groupLink(context, event.groupId), {
        quote_count: String(event.quotes.length),
        quotes: enumeration(
          event.quotes.map(
            (quote) => `${quotedService(quote.serviceName)} (${formatXof(quote.total.amount)})`,
          ),
        ),
        total: formatXof(event.total.amount),
        valid_until,
      }),
    ];
  },

  'cleaning.booking.confirmed': (event, context) => [
    customer(event.customerId, 'cleaning.booking_confirmed.customer', missionLink(context, event.missionId), {
      total: formatXof(event.total.amount),
      planned_interventions: String(event.plannedInterventions),
      payment_note: paymentNote({
        ...event.paymentPlan,
        total: event.total.amount,
        deposit: event.depositAmount.amount,
      }),
      ...withService(event.serviceName),
    }),
  ],

  'cleaning.mission.scheduled': (event, context) => {
    const variables = {
      date: dateTime(event.scheduledStart, context),
      duration: formatDuration(event.durationMinutes),
      ...withService(event.serviceName),
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
        ...withService(event.serviceName),
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
    event.cause === ORGANIZATION_SUSPENDED
      ? customer(
          event.customerId,
          'cleaning.contract_suspended_organization.customer',
          missionLink(context, event.missionId),
          {},
        )
      : customer(
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
    // Motif de la reprise : dernière cause levée (règlement des impayés ou réactivation).
    const variant =
      event.cause === ORGANIZATION_SUSPENDED ? 'contract_resumed_organization' : 'contract_resumed';
    return [
      customer(
        event.customerId,
        `cleaning.${variant}.customer`,
        missionLink(context, event.missionId),
        counts,
      ),
      ...team(context, `cleaning.${variant}.team`, { ...counts, mission_id: event.missionId }),
    ];
  },

  // Cause ajoutée ou levée, la mission restant suspendue (ADR-030).
  'cleaning.contract.suspension_updated': (event, context) => {
    const kind = event.cause === ORGANIZATION_SUSPENDED ? 'organization' : 'unpaid';
    const unpaidCause = event.causes.find((cause) => cause !== ORGANIZATION_SUSPENDED) ?? 'unpaid_invoices';
    // Lien vers les factures quand des factures impayées maintiennent ou rejoignent la suspension.
    const invoicesMatter = event.causes.includes('unpaid_invoices');
    return [
      customer(
        event.customerId,
        'cleaning.suspension_updated.customer',
        invoicesMatter ? invoicesLink(context) : missionLink(context, event.missionId),
        {
          case: `${kind}_${event.change === 'cause_added' ? 'added' : 'lifted'}`,
          unpaid_text: unpaidText(unpaidCause, event.unpaidCount),
        },
      ),
    ];
  },

  'cleaning.rescheduling.failed': (event, context) =>
    team(context, 'cleaning.rescheduling_failed.team', {
      mission_id: event.missionId,
      failed_count: String(event.failedCount),
    }),
};
