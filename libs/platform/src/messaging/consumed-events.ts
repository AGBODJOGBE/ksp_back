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
  billing: [
    'cleaning.booking.confirmed',
    'cleaning.request.cancelled',
    'cleaning.contract.suspended',
    'cleaning.contract.resumed',
    'payment.intent.succeeded',
  ],
  cleaning: [
    'billing.invoice.overdue',
    'billing.invoice.paid',
    'identity.organization.suspended',
    'identity.organization.reactivated',
    'identity.user.deleted',
    'payment.intent.succeeded',
  ],
  document: ['identity.user.deleted'],
  file: ['identity.user.deleted'],
  notification: [
    'billing.invoice.issued',
    'billing.invoice.overdue',
    'billing.invoice.paid',
    'cleaning.booking.confirmed',
    'cleaning.contract.resumed',
    'cleaning.contract.suspended',
    'cleaning.contract.suspension_updated',
    'cleaning.contract.suspension_warning',
    'cleaning.mission.completed',
    'cleaning.mission.scheduled',
    'cleaning.quote.requested',
    'cleaning.quote.sent',
    'cleaning.quote_group.requested',
    'cleaning.quote_group.sent',
    'cleaning.request.cancelled',
    'cleaning.rescheduling.failed',
    'cleaning.visit.scheduled',
    'identity.organization.created',
    'identity.organization.reactivated',
    'identity.organization.rejected',
    'identity.organization.suspended',
    'identity.organization.validated',
    'identity.user.deleted',
    'identity.user.deletion_cancelled',
    'identity.user.deletion_requested',
    'payment.intent.succeeded',
    'wallet.prepaid.credited',
    'wallet.prepaid.debited',
  ],
  wallet: [
    'cleaning.mission.credited',
    'cleaning.mission.refunded',
    'payment.intent.succeeded',
    'payment.payout.completed',
    'payment.payout.failed',
  ],
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
