import { type CleaningEventPayloads, type CleaningEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import { CLEANING_PROGRAM_RULES } from './cleaning-programs.rules';
import { CLEANING_SESSION_RULES } from './cleaning-sessions.rules';
import {
  agents,
  backOffice,
  backOfficePath,
  customer,
  DECLINE_REASONS,
  placeLabel,
  portal,
  REJECTION_REASONS,
  staff,
} from './cleaning.recipients';
import { type EventRule } from './event-rules';
import { eventDate as day, eventDateTime as dateTime } from './rule-dates';

/**
 * Messages des événements du Nettoyage, refonte v2 (ADR-054 ; CDC Nettoyage v2, 16.2 ; lot G, D40).
 * Ce fichier : demande, visite des lieux et devis ; programmes, agents et réclamations dans
 * cleaning-programs.rules.ts ; séances et leur paiement dans cleaning-sessions.rules.ts.
 *
 * Destinataires (cleaning.recipients.ts) : le client du dossier (customerId) ; les administrateurs
 * d'une organisation pour un devis transmis pour accord ; les agents de la visite ; le superviseur
 * de la zone (permission `cleaning.request.process` dans la commune du lieu, ListStaffByPermission,
 * RV-62). Un dossier est désigné par son numéro (« dossier DN-000124 »), le lieu par les libellés du
 * catalogue ; jamais d'adresse ni de texte libre (16.3).
 *
 * Décisions du lot G hors du tableau 16.2 : la demande refusée, le devis retiré (R-VI-07, RV-50),
 * le paiement laissé au portefeuille (R-PP-07) et le client absent à la visite (R-VI-05) préviennent
 * aussi le client. La demande annulée garde son message v1, réécrit sur place.
 */

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
 * Causes d'une visite annulée avec sa demande : l'agent apprend que la demande a été close ; le
 * client est prévenu par le message de sa demande.
 */
const CLOSED_REQUEST_CAUSES: ReadonlySet<string> = new Set(['request_cancelled', 'request_rejected']);

type RequestEventType = Extract<
  CleaningEventType,
  `cleaning.request.${string}` | `cleaning.visit.${string}` | `cleaning.quote.${string}`
>;

const CLEANING_REQUEST_RULES: {
  readonly [T in RequestEventType]: EventRule<T>;
} = {
  // Demande envoyée : le client ; le superviseur de la zone quand les frais de visite sont payés
  // (sinon, au paiement : cleaning.request.visit_fee_paid).
  'cleaning.request.submitted': (event, context) => [
    customer(event, 'cleaning.request_submitted.customer', portal.request(context, event), {
      request_number: event.requestNumber,
      place: placeLabel(event),
      case: event.visitFeeStatus,
      visit_fee: formatXof(event.visitFee.amount),
    }),
    ...(event.visitFeeStatus === 'paid'
      ? [
          staff(
            'cleaning.request.process',
            event.communeKey,
            'cleaning.request_submitted.staff',
            backOffice(context, backOfficePath.request(event.requestId)),
            { request_number: event.requestNumber, place: placeLabel(event) },
          ),
        ]
      : []),
  ],

  'cleaning.request.cancelled': (event, context) => [
    customer(event, 'cleaning.request_cancelled.customer', portal.request(context, event), {
      case: CANCELLATION_CASES[event.cause],
      scope: 'request',
    }),
  ],

  // Demande refusée par KSP (R-AC-05) : le client, motif de la liste et remboursement des frais.
  'cleaning.request.rejected': (event, context) => [
    customer(event, 'cleaning.request_rejected.customer', portal.request(context, event), {
      request_number: event.requestNumber,
      reason: REJECTION_REASONS[event.reasonCode],
      ...(event.visitFeeRefund && event.visitFeeRefund.amount > 0
        ? { refund: formatXof(event.visitFeeRefund.amount) }
        : {}),
    }),
  ],

  // Frais de visite payés : le client (reçu, ou la demande sans reçu) ; le personnel qui traite les
  // demandes. Sans clé de commune dans l'événement : attributions globales seulement.
  'cleaning.request.visit_fee_paid': (event, context) => [
    customer(
      event,
      'cleaning.visit_fee_paid.customer',
      event.invoiceId
        ? portal.invoice(context, event.invoiceId, event.organizationId)
        : portal.request(context, event),
      { request_number: event.requestNumber, amount: formatXof(event.amount.amount) },
    ),
    staff(
      'cleaning.request.process',
      null,
      'cleaning.visit_fee_paid.staff',
      backOffice(context, backOfficePath.request(event.requestId)),
      { request_number: event.requestNumber, rank: String(event.rank) },
    ),
  ],

  // Réactivation d'un devis expiré (R-AC-04) : le superviseur l'accepte ou la refuse.
  'cleaning.request.reactivation_requested': (event, context) => [
    staff(
      'cleaning.request.process',
      event.communeKey,
      'cleaning.reactivation_requested.staff',
      backOffice(context, backOfficePath.request(event.requestId)),
      { request_number: event.requestNumber },
    ),
  ],

  // Visite planifiée : le client et chaque agent. Déplacée : la nouvelle date au client et aux agents
  // de la visite, l'ancienne aux agents retirés.
  'cleaning.visit.scheduled': (event, context) => {
    const date = dateTime(event.scheduledAt, context);
    const released = agents(event.releasedAgentIds, 'cleaning.visit_released.agent', {
      request_number: event.requestNumber,
      date: dateTime(event.previousScheduledAt ?? event.scheduledAt, context),
    });
    if (event.previousScheduledAt === null) {
      return [
        customer(event, 'cleaning.visit_scheduled.customer', portal.request(context, event), { date }),
        ...agents(event.agentIds, 'cleaning.visit_scheduled.agent', { date }),
        ...released,
      ];
    }
    const moved = {
      request_number: event.requestNumber,
      date,
      previous_date: dateTime(event.previousScheduledAt, context),
    };
    return [
      customer(event, 'cleaning.visit_rescheduled.customer', portal.request(context, event), moved),
      ...agents(event.agentIds, 'cleaning.visit_rescheduled.agent', moved),
      ...released,
    ];
  },

  // Visite annulée : les agents libérés ; le client, sauf quand sa demande est close (il est prévenu
  // par le message de la demande).
  'cleaning.visit.cancelled': (event, context) => {
    const date = dateTime(event.scheduledAt, context);
    if (CLOSED_REQUEST_CAUSES.has(event.cause)) {
      return agents(event.releasedAgentIds, 'cleaning.visit_cancelled.agent', {
        date,
        services: file(event.requestNumber),
      });
    }
    return [
      customer(event, 'cleaning.visit_cancelled.customer', portal.request(context, event), {
        case: event.cause,
        request_number: event.requestNumber,
        date,
        ...(event.visitFeeRefund && event.visitFeeRefund.amount > 0
          ? { refund: formatXof(event.visitFeeRefund.amount) }
          : {}),
      }),
      ...agents(event.releasedAgentIds, 'cleaning.visit_released.agent', {
        request_number: event.requestNumber,
        date,
      }),
    ];
  },

  'cleaning.visit.arrived': (event, context) => [
    customer(event, 'cleaning.visit_arrived.customer', portal.request(context, event), {
      request_number: event.requestNumber,
    }),
  ],

  // Constat terminé : le devis suit.
  'cleaning.visit.completed': (event, context) => [
    customer(event, 'cleaning.visit_completed.customer', portal.request(context, event), {
      request_number: event.requestNumber,
    }),
  ],

  // Client absent à la visite (R-VI-05) : le client, avec les nouveaux frais et leur échéance
  // (R-FV-03) ; le superviseur de la zone.
  'cleaning.visit.missed': (event, context) => [
    customer(event, 'cleaning.visit_missed.customer', portal.request(context, event), {
      request_number: event.requestNumber,
      date: dateTime(event.missedAt, context),
      visit_fee: formatXof(event.newVisitFee.amount),
      pay_before: dateTime(event.newVisitFeePayBefore, context),
    }),
    staff(
      'cleaning.request.process',
      event.communeKey,
      'cleaning.visit_missed.staff',
      backOffice(context, backOfficePath.request(event.requestId)),
      { request_number: event.requestNumber, date: dateTime(event.missedAt, context) },
    ),
  ],

  // Devis envoyé ou révisé ; renouvellement proposé (16.2) : son propre message.
  'cleaning.quote.sent': (event, context) =>
    event.kind === 'renewal'
      ? [
          customer(event, 'cleaning.renewal_proposed.customer', portal.request(context, event), {
            request_number: event.requestNumber,
            total: formatXof(event.total.amount),
            valid_until: day(event.validUntil, context),
          }),
        ]
      : [
          customer(event, 'cleaning.quote_sent.customer', portal.request(context, event), {
            total: formatXof(event.total.amount),
            valid_until: day(event.validUntil, context),
          }),
        ],

  // Devis transmis pour accord (R-AC-02) : les administrateurs actuels de l'organisation, chacun par
  // ses canaux (pas l'e-mail de facturation).
  'cleaning.quote.forwarded': (event, context) =>
    event.organizationId
      ? [
          {
            ...customer(event, 'cleaning.quote_forwarded.customer', portal.request(context, event), {
              request_number: event.requestNumber,
            }),
            organizationId: event.organizationId,
            billingEmailCopy: false,
          },
        ]
      : [],

  // Devis retiré, nouvelle visite demandée par KSP (R-VI-07, RV-50) : le client.
  'cleaning.quote.withdrawn': (event, context) => [
    customer(event, 'cleaning.quote_withdrawn.customer', portal.request(context, event), {
      request_number: event.requestNumber,
    }),
  ],

  // Devis accepté : le personnel des programmes (programme à planifier). Le client est prévenu par
  // la confirmation du programme. Sans clé de commune : attributions globales.
  'cleaning.quote.accepted': (event, context) => [
    staff(
      'cleaning.program.manage',
      null,
      'cleaning.quote_accepted.staff',
      backOffice(context, backOfficePath.program(event.programId)),
      { request_number: event.requestNumber },
    ),
  ],

  // Devis refusé (R-AC-03) : le superviseur de la zone.
  'cleaning.quote.declined': (event, context) => [
    staff(
      'cleaning.request.process',
      event.communeKey,
      'cleaning.quote_declined.staff',
      backOffice(context, backOfficePath.request(event.requestId)),
      {
        request_number: event.requestNumber,
        reason: event.reasonCode ? DECLINE_REASONS[event.reasonCode] : 'sans motif',
      },
    ),
  ],

  'cleaning.quote.expiry_reminded': (event, context) => [
    customer(event, 'cleaning.quote_expiry_reminder.customer', portal.request(context, event), {
      quote_count: '1',
      quotes: quoteOf(event),
      valid_until: day(event.validUntil, context),
    }),
  ],

  // Devis expiré : le client ; le superviseur de la zone.
  'cleaning.quote.expired': (event, context) => [
    customer(event, 'cleaning.quote_expired.customer', portal.request(context, event), {
      quote_count: '1',
      quotes: quoteOf(event),
    }),
    staff(
      'cleaning.request.process',
      event.communeKey,
      'cleaning.quote_expired.staff',
      backOffice(context, backOfficePath.request(event.requestId)),
      { request_number: event.requestNumber },
    ),
  ],
};

/**
 * Toutes les règles du Nettoyage v2 : une par événement publié par cleaning (45). Un nouvel
 * événement du contrat fait échouer la vérification des types tant qu'il n'a pas sa règle.
 */
export const CLEANING_RULES: { readonly [T in CleaningEventType]: EventRule<T> } = {
  ...CLEANING_REQUEST_RULES,
  ...CLEANING_PROGRAM_RULES,
  ...CLEANING_SESSION_RULES,
};
