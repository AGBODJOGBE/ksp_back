import { type CleaningEventType } from '@ksp/contracts';
import { formatXof } from '../../domain/messages/format';
import {
  agents,
  backOffice,
  backOfficePath,
  causesLabel,
  CLAIM_CATEGORIES,
  customer,
  LEFT_IN_WALLET_CAUSES,
  PAID_OBJECTS,
  payer,
  placeLabel,
  portal,
  staff,
  SUSPENSION_CAUSES,
} from './cleaning.recipients';
import { type EventRule, type NotificationIntent, type RuleContext } from './event-rules';
import { eventDate as day, eventDateTime as dateTime } from './rule-dates';

/**
 * Messages du Nettoyage v2 : programmes, suspension et reprise, avertissement d'impayés d'une
 * organisation, paiement laissé au portefeuille (R-PP-07), agents et réclamations (CDC Nettoyage v2, 16.2).
 *
 * Suspension, reprise et avertissement vont au « client » de 16.2 : le particulier, ou les
 * administrateurs actuels de l'organisation avec la copie à son e-mail de facturation (ADR-050).
 * Le personnel prévenu : `cleaning.program.manage` dans la zone du lieu (superviseur ; l'admin par
 * son attribution globale), ou globalement quand l'événement n'a pas de clé de commune ;
 * `cleaning.agent.manage` pour les candidatures (admin) ; `cleaning.claim.manage` pour les
 * réclamations. Les textes ne promettent jamais une reprise certaine (ADR-030).
 */

type Cause = keyof typeof SUSPENSION_CAUSES;

/** Lien d'une suspension : les factures quand des impayés en sont la cause (RV-84), sinon le programme. */
function suspensionLink(
  context: RuleContext,
  event: { programId: string; organizationId: string | null },
  causes: readonly Cause[],
): string {
  return causes.includes('unpaid_invoices')
    ? portal.invoices(context, event.organizationId)
    : portal.program(context, event);
}

type ProgramEventType = Extract<
  CleaningEventType,
  | `cleaning.program.${string}`
  | 'cleaning.organization.unpaid_warning'
  | 'cleaning.direct_payment.left_in_wallet'
  | `cleaning.agent.${string}`
  | `cleaning.claim.${string}`
>;

export const CLEANING_PROGRAM_RULES: { readonly [T in ProgramEventType]: EventRule<T> } = {
  // Programme confirmé (le devis accepté) : le client.
  'cleaning.program.confirmed': (event, context) => [
    customer(event, 'cleaning.program_confirmed.customer', portal.program(context, event), {
      program_number: event.programNumber,
      place: placeLabel(event),
      sessions_count: String(event.sessionsCount),
      first_date: dateTime(event.firstSessionAt, context),
      total: formatXof(event.total.amount),
    }),
  ],

  'cleaning.program.suspended': (event, context) => [
    payer(event, 'cleaning.program_suspended.customer', suspensionLink(context, event, event.causes), {
      causes: causesLabel(event.causes),
    }),
    staff(
      'cleaning.program.manage',
      event.communeKey,
      'cleaning.program_suspended.staff',
      backOffice(context, backOfficePath.program(event.programId)),
      { causes: causesLabel(event.causes) },
    ),
  ],

  // Cause ajoutée ou levée, programme toujours suspendu : le client ; le back-office pour une
  // décision de KSP. Sans clé de commune : attributions globales.
  'cleaning.program.suspension_updated': (event, context) => [
    payer(
      event,
      'cleaning.program_suspension_updated.customer',
      suspensionLink(context, event, event.causes),
      { case: event.change, cause: SUSPENSION_CAUSES[event.cause], causes: causesLabel(event.causes) },
    ),
    ...(event.cause === 'ksp_decision'
      ? [
          staff(
            'cleaning.program.manage',
            null,
            'cleaning.program_suspension_updated.staff',
            backOffice(context, backOfficePath.program(event.programId)),
            { case: event.change, causes: causesLabel(event.causes) },
          ),
        ]
      : []),
  ],

  'cleaning.program.resumed': (event, context) => [
    payer(event, 'cleaning.program_resumed.customer', portal.program(context, event), {}),
    staff(
      'cleaning.program.manage',
      event.communeKey,
      'cleaning.program_resumed.staff',
      backOffice(context, backOfficePath.program(event.programId)),
      {
        cause: SUSPENSION_CAUSES[event.liftedCause],
        sessions_to_assign: String(event.sessionsToAssign),
        catch_up: String(new Set(event.catchUpSessionIds).size),
      },
    ),
  ],

  // Programme terminé : le client ; « commander à nouveau » pour un ponctuel (R-PG-08).
  'cleaning.program.completed': (event, context) => {
    const oneOff = event.planKind === 'one_off';
    return [
      customer(
        event,
        'cleaning.program_completed.customer',
        oneOff ? portal.reorder(context, event) : portal.program(context, event),
        {
          program_number: event.programNumber,
          sessions_completed: String(event.sessionsCompleted),
          end_date: day(event.completedAt, context),
          case: oneOff ? 'one_off' : 'recurring',
        },
      ),
    ];
  },

  // Programme arrêté : ses séances sont annulées ; le client et les agents libérés (RV-67).
  'cleaning.program.cancelled': (event, context) => [
    customer(event, 'cleaning.program_cancelled.customer', portal.program(context, event), {
      case: event.cancelledBy,
    }),
    ...agents(event.releasedAgentIds, 'cleaning.program_released.agent', {}),
  ],

  // Avertissement avant suspension (R-PE-06) : administrateurs de l'organisation, avec un lien vers
  // les factures ; le back-office (attributions globales : l'organisation n'a pas de zone).
  'cleaning.organization.unpaid_warning': (event, context) => {
    const link = portal.invoices(context, event.organizationId);
    const counts = {
      unpaid_count: String(event.unpaidCount),
      suspension_threshold: String(event.suspensionThreshold),
    };
    const organization: NotificationIntent = {
      userId: '',
      templateCode: 'cleaning.unpaid_warning.customer',
      variables: { ...counts, organization_name: '', link },
      link,
      organizationId: event.organizationId,
    };
    return [
      organization,
      staff(
        'cleaning.program.manage',
        null,
        'cleaning.unpaid_warning.staff',
        backOffice(context, backOfficePath.organization(event.organizationId)),
        counts,
      ),
    ];
  },

  // Paiement reçu pour un objet qui n'est plus payable (R-PP-07) : le client ; le montant reste
  // disponible dans son portefeuille.
  'cleaning.direct_payment.left_in_wallet': (event, context) => [
    customer(event, 'cleaning.payment_left_in_wallet.customer', portal.wallet(context), {
      amount: formatXof(event.amount.amount),
      object: PAID_OBJECTS[event.objectType],
      reason: LEFT_IN_WALLET_CAUSES[event.cause],
    }),
  ],

  // Candidature : l'agent (accusé de réception, ou profil créé pour lui) ; l'admin des zones
  // souhaitées pour une candidature spontanée (un profil créé ou une invitation vient de l'admin).
  'cleaning.agent.applied': (event, context) => {
    const zones = event.zoneKeys.length > 0 ? [...new Set(event.zoneKeys)] : [null];
    const link = backOffice(context, backOfficePath.agent(event.agentId));
    return [
      {
        userId: event.userId,
        templateCode: 'cleaning.agent_applied.agent',
        variables: { case: event.source },
        link: null,
      },
      ...(event.source === 'self'
        ? zones.map((zone) => staff('cleaning.agent.manage', zone, 'cleaning.agent_applied.staff', link, {}))
        : []),
    ];
  },

  'cleaning.agent.approved': (event) => [
    { userId: event.userId, templateCode: 'cleaning.agent_approved.agent', variables: {}, link: null },
  ],

  // Réclamation ouverte : le client (accusé de réception) ; le personnel des réclamations de la zone.
  'cleaning.claim.opened': (event, context) => [
    customer(event, 'cleaning.claim_opened.customer', portal.claim(context, event), {}),
    staff(
      'cleaning.claim.manage',
      event.communeKey,
      'cleaning.claim_opened.staff',
      backOffice(context, backOfficePath.claim(event.claimId)),
      { category: CLAIM_CATEGORIES[event.category] },
    ),
  ],

  // Réclamation tranchée par le back-office : le client.
  'cleaning.claim.resolved': (event, context) => [
    customer(event, 'cleaning.claim_resolved.customer', portal.claim(context, event), {
      case: event.outcome,
      ...(event.creditAmount && event.creditAmount.amount > 0
        ? { amount: formatXof(event.creditAmount.amount) }
        : {}),
    }),
  ],
};
