import { type CleaningEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import {
  agents,
  backOffice,
  backOfficePath,
  customer,
  INCIDENT_CATEGORIES,
  MISSED_CAUSES,
  portal,
  sessionLabel,
  staff,
} from './cleaning.recipients';
import { type EventRule, type RuleContext } from './event-rules';
import { eventDateTime as dateTime } from './rule-dates';

/**
 * Messages du Nettoyage v2 : séances et leur paiement (CDC Nettoyage v2, 16.2).
 *
 * Une séance est désignée par son rang et le numéro de son programme (« séance 3 sur 12 du
 * programme PN-000057 »). Un lot de séances affectées par un même appel donne un seul message
 * récapitulatif par destinataire (RV-71) : les événements unitaires qui portent son `batchId`
 * n'envoient rien. Le personnel prévenu porte `cleaning.program.manage` dans la commune du lieu
 * (superviseur de la zone ; l'admin aussi, par son attribution globale).
 */

function sessionLink(
  context: RuleContext,
  event: { programId: string; sessionId: string; organizationId: string | null },
): string {
  return portal.session(context, event);
}

function sessionBackOffice(
  context: RuleContext,
  event: { programId: string; sessionId: string },
): string | null {
  return backOffice(context, backOfficePath.session(event.programId, event.sessionId));
}

/**
 * Retraits d'agents sans message de retrait : un report (cleaning.session.rescheduled prévient les
 * agents retirés) et le refus de l'agent lui-même.
 */
const SILENT_UNASSIGNMENTS: ReadonlySet<string> = new Set(['rescheduled', 'agent_declined']);

type SessionEventType = Extract<
  CleaningEventType,
  `cleaning.session.${string}` | `cleaning.sessions.${string}`
>;

export const CLEANING_SESSION_RULES: { readonly [T in SessionEventType]: EventRule<T> } = {
  // Agents affectés, changement d'équipe : le client et l'équipe complète après l'affectation.
  'cleaning.session.assigned': (event, context) => {
    if (event.batchId) return [];
    const variables = { session: sessionLabel(event), date: dateTime(event.scheduledStart, context) };
    return [
      customer(event, 'cleaning.session_assigned.customer', sessionLink(context, event), variables),
      ...agents(event.agentIds, 'cleaning.session_assigned.agent', variables),
    ];
  },

  // Lot de séances d'un programme : un récapitulatif au client et à chaque agent.
  'cleaning.sessions.batch_assigned': (event, context) => {
    const variables = {
      count: String(event.count),
      first_date: dateTime(event.firstStart, context),
      last_date: dateTime(event.lastStart, context),
    };
    return [
      customer(event, 'cleaning.sessions_assigned.customer', portal.program(context, event), variables),
      ...agents(event.agentIds, 'cleaning.sessions_assigned.agent', variables),
    ];
  },

  // Agents retirés : chacun apprend que la séance ne lui est plus confiée.
  'cleaning.session.unassigned': (event, context) =>
    event.batchId || SILENT_UNASSIGNMENTS.has(event.cause)
      ? []
      : agents(event.agentIds, 'cleaning.session_released.agent', {
          session: sessionLabel(event),
          date: dateTime(event.scheduledStart, context),
        }),

  // Séance reportée : la nouvelle date au client et aux agents gardés, l'ancienne aux agents retirés
  // (R-RP-01).
  'cleaning.session.rescheduled': (event, context) => {
    const moved = {
      session: sessionLabel(event),
      date: dateTime(event.scheduledStart, context),
      previous_date: dateTime(event.previousStart, context),
    };
    return [
      customer(event, 'cleaning.session_rescheduled.customer', sessionLink(context, event), moved),
      ...agents(event.agentIds, 'cleaning.session_rescheduled.agent', moved),
      ...agents(event.releasedAgentIds, 'cleaning.session_released.agent', {
        session: moved.session,
        date: moved.previous_date,
      }),
    ];
  },

  // Séance annulée : le client (faute d'agent : rien à payer, nouvelle date à choisir, R-PL-10) et
  // les agents libérés.
  'cleaning.session.cancelled': (event, context) => {
    const variables = { session: sessionLabel(event), date: dateTime(event.scheduledStart, context) };
    return [
      customer(event, 'cleaning.session_cancelled.customer', sessionLink(context, event), {
        ...variables,
        case: event.cause,
      }),
      ...agents(event.releasedAgentIds, 'cleaning.session_released.agent', variables),
    ];
  },

  // Rappel la veille (R-PP-05) : le client, avec l'état de son solde (particulier), et les agents.
  'cleaning.session.reminder': (event, context) => {
    const variables = { session: sessionLabel(event), date: dateTime(event.scheduledStart, context) };
    const balance =
      event.balanceSufficient === null ? 'invoiced' : event.balanceSufficient ? 'sufficient' : 'insufficient';
    return [
      customer(event, 'cleaning.session_reminder.customer', sessionLink(context, event), {
        ...variables,
        case: balance,
        ...(event.amountDue ? { amount: formatXof(event.amountDue.amount) } : {}),
      }),
      ...agents(event.agentIds, 'cleaning.session_reminder.agent', variables),
    ];
  },

  // Solde insuffisant (R-WL-06) : le client, avec le lien de recharge.
  'cleaning.session.balance_insufficient': (event, context) => [
    customer(event, 'cleaning.balance_insufficient.customer', portal.wallet(context), {
      session: sessionLabel(event),
      date: dateTime(event.scheduledStart, context),
      amount_due: formatXof(event.amountDue.amount),
      missing: formatXof(event.missing.amount),
    }),
  ],

  // Équipe arrivée, séance démarrée, réalisée : le client.
  'cleaning.session.arrived': (event, context) => [
    customer(event, 'cleaning.session_arrived.customer', sessionLink(context, event), {
      session: sessionLabel(event),
    }),
  ],
  'cleaning.session.started': (event, context) => [
    customer(event, 'cleaning.session_started.customer', sessionLink(context, event), {
      session: sessionLabel(event),
    }),
  ],
  'cleaning.session.completed': (event, context) => [
    customer(event, 'cleaning.session_completed.customer', sessionLink(context, event), {
      session: sessionLabel(event),
    }),
  ],

  // Incident : le superviseur de la zone (puis l'admin, attribution globale).
  'cleaning.session.interrupted': (event, context) => [
    staff(
      'cleaning.program.manage',
      event.communeKey,
      'cleaning.session_interrupted.staff',
      sessionBackOffice(context, event),
      {
        session: sessionLabel(event),
        category: INCIDENT_CATEGORIES[event.category],
      },
    ),
  ],

  // Client absent ou accès impossible : le superviseur de la zone. Une annulation tardive passe par
  // le support : pas d'alerte.
  'cleaning.session.missed': (event, context) =>
    event.cause === 'late_cancellation'
      ? []
      : [
          staff(
            'cleaning.program.manage',
            event.communeKey,
            'cleaning.session_missed.staff',
            sessionBackOffice(context, event),
            {
              session: sessionLabel(event),
              cause: MISSED_CAUSES[event.cause],
            },
          ),
        ],

  // Séance sans agent (R-PL-06, R-PL-10) ou agent absent : le superviseur de la zone ; cleaning
  // envoie un niveau d'alerte à la fois.
  'cleaning.session.staffing_alert': (event, context) => [
    staff(
      'cleaning.program.manage',
      event.communeKey,
      'cleaning.staffing_alert.staff',
      sessionBackOffice(context, event),
      {
        case: event.level,
        program_number: event.programNumber,
        session: sessionLabel(event),
        date: dateTime(event.scheduledStart, context),
        missing: String(event.missingAgents),
      },
    ),
  ],

  // Séance à payer, payée (facture), en retard : le client ; le retard aussi au superviseur.
  'cleaning.session.payment_due': (event, context) => [
    customer(event, 'cleaning.session_payment_due.customer', sessionLink(context, event), {
      session: sessionLabel(event),
      amount: formatXof(event.amountDue.amount),
      due_by: dateTime(event.dueBy, context),
    }),
  ],
  'cleaning.session.paid': (event, context) => [
    customer(
      event,
      'cleaning.session_paid.customer',
      event.invoiceId
        ? portal.invoice(context, event.invoiceId, event.organizationId)
        : sessionLink(context, event),
      { session: sessionLabel(event), amount: formatXof(event.amountPaid.amount) },
    ),
  ],
  'cleaning.session.overdue': (event, context) => [
    customer(event, 'cleaning.session_overdue.customer', sessionLink(context, event), {
      session: sessionLabel(event),
      amount: formatXof(event.amountDue.amount),
    }),
    staff(
      'cleaning.program.manage',
      event.communeKey,
      'cleaning.session_overdue.staff',
      sessionBackOffice(context, event),
      {
        session: sessionLabel(event),
        overdue_count: String(event.overdueCount),
      },
    ),
  ],
};
