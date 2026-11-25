import { type KspEventType } from '@ksp/contracts';

/**
 * Abonnements de chaque service consommateur (ADR-047). Le publieur s'en sert pour savoir si un
 * événement non routé (aucune file liée) est une perte : pour un type attendu par au moins un
 * consommateur, c'est un échec de publication, et l'outbox réessaie jusqu'à ce que la file existe
 * (consommateur pas encore démarré). Un type absent d'ici n'intéresse personne : non routé, il est
 * abandonné comme avant.
 *
 * À tenir à jour avec chaque `RabbitMqConsumer.subscribe` (une alerte est journalisée au démarrage
 * pour un abonnement absent d'ici) ; déclarer un nouvel abonnement ici dans la même modification.
 */
export const EVENT_CONSUMERS = {
  // Facture mensuelle des entreprises : séances réalisées et manquées, avec leur montant dû
  // (CDC Nettoyage v2, 15.5 et R-PE-01). Déclarés avant l'abonnement de billing (lot F) : publiés plus
  // tôt par cleaning, ils restent dans son outbox (mis de côté au bout de 24 h, rejouables), jamais perdus.
  billing: [
    'cleaning.session.completed',
    'cleaning.session.missed',
    'payment.intent.succeeded',
    // Lot F (R-PE-04) : virement ou Mobile Money crédité au portefeuille pour une facture
    // (forObject "billing_invoice"), débité aussitôt.
    'wallet.prepaid.credited',
    // Recouvrement (ADR-064) : encaissements de la facture mensuelle de commission, et débits des
    // frais de dossier par recovery (service "recovery") qui donnent chacun un reçu.
    'recovery.payment.collected',
    'wallet.prepaid.debited',
  ],
  cleaning: [
    'billing.invoice.overdue',
    'billing.invoice.paid',
    'identity.organization.suspended',
    'identity.organization.reactivated',
    'identity.user.deleted',
    // Suivi du paiement direct seulement : le débit ne part jamais de cet événement.
    'payment.intent.succeeded',
    // Paiement direct (R-WL-05, R-PP-03) : crédit dont forObject désigne une demande ou une séance,
    // seul déclencheur du débit qui le suit ; toute recharge relance aussi les débits en attente
    // (frais de visite, séances en retard, séances à payer).
    'wallet.prepaid.credited',
  ],
  document: ['identity.user.deleted'],
  file: ['identity.user.deleted'],
  // Nettoyage v2 (CDC 16.2, lot G, D40) : les 45 événements publiés par cleaning.
  notification: [
    'billing.invoice.issued',
    'billing.invoice.overdue',
    'billing.invoice.paid',
    'cleaning.agent.applied',
    'cleaning.agent.approved',
    'cleaning.claim.opened',
    'cleaning.claim.resolved',
    'cleaning.direct_payment.left_in_wallet',
    'cleaning.organization.unpaid_warning',
    'cleaning.program.cancelled',
    'cleaning.program.completed',
    'cleaning.program.confirmed',
    'cleaning.program.resumed',
    'cleaning.program.suspended',
    'cleaning.program.suspension_updated',
    'cleaning.quote.accepted',
    'cleaning.quote.declined',
    'cleaning.quote.expired',
    'cleaning.quote.expiry_reminded',
    'cleaning.quote.forwarded',
    'cleaning.quote.sent',
    'cleaning.quote.withdrawn',
    'cleaning.request.cancelled',
    'cleaning.request.reactivation_requested',
    'cleaning.request.rejected',
    'cleaning.request.submitted',
    'cleaning.request.visit_fee_paid',
    'cleaning.session.arrived',
    'cleaning.session.assigned',
    'cleaning.session.balance_insufficient',
    'cleaning.session.cancelled',
    'cleaning.session.completed',
    'cleaning.session.interrupted',
    'cleaning.session.missed',
    'cleaning.session.overdue',
    'cleaning.session.paid',
    'cleaning.session.payment_due',
    'cleaning.session.reminder',
    'cleaning.session.rescheduled',
    'cleaning.session.staffing_alert',
    'cleaning.session.started',
    'cleaning.session.unassigned',
    'cleaning.sessions.batch_assigned',
    'cleaning.visit.arrived',
    'cleaning.visit.cancelled',
    'cleaning.visit.completed',
    'cleaning.visit.missed',
    'cleaning.visit.scheduled',
    'identity.organization.created',
    'identity.organization.reactivated',
    'identity.organization.rejected',
    'identity.organization.suspended',
    'identity.organization.validated',
    'identity.user.deleted',
    'identity.user.deletion_cancelled',
    'identity.user.deletion_requested',
    'identity.user.mfa_reset',
    'payment.intent.succeeded',
    'recovery.case.accepted',
    'recovery.case.closed',
    'recovery.case.info_requested',
    'recovery.case.rejected',
    'recovery.case.resumed',
    'recovery.case.submitted',
    'recovery.case.suspended',
    'recovery.decision.requested',
    'recovery.notice.issued',
    'recovery.partner.act_recorded',
    'recovery.partner.assigned',
    'recovery.payment.collected',
    'recovery.plan.defaulted',
    'recovery.plan.installment_missed',
    'recovery.plan.signed',
    'recovery.remittance.paid',
    'wallet.prepaid.credited',
    'wallet.prepaid.debited',
  ],
  recovery: ['document.signature.completed'],
  wallet: ['payment.intent.succeeded', 'payment.payout.completed', 'payment.payout.failed'],
} as const satisfies Record<string, readonly KspEventType[]>;

/** Types d'événements attendus par au moins un consommateur. */
export const CONSUMED_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(EVENT_CONSUMERS).flat());

/** Vrai si `consumer` a déclaré son abonnement à `eventType` dans EVENT_CONSUMERS. */
export function isDeclaredSubscription(consumer: string, eventType: string): boolean {
  const declared = (EVENT_CONSUMERS as Record<string, readonly string[]>)[consumer];
  return declared?.includes(eventType) ?? false;
}

/**
 * Service propriétaire d'un type d'événement : le préfixe du type (`payment.intent.succeeded` →
 * `payment`). Seul ce service peut le publier (vérifié à la réception, ADR-047).
 */
export function eventOwner(eventType: string): string {
  return eventType.split('.')[0];
}
