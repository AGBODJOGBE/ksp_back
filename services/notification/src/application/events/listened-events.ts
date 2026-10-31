import { type KspEventType } from '@ksp/contracts';
import { BILLING_RULES } from './billing.rules';
import { CLEANING_RULES } from './cleaning.rules';
import { type EventRules } from './event-rules';
import { ORGANIZATION_RULES } from './organization.rules';
import { PAYMENT_RULES } from './payment.rules';

/**
 * Événements écoutés par notification, avec leur règle. Chaque événement a sa file
 * `notification.<événement>` (et ses files `.retry` et `.dlq`).
 *
 * Nettoyage : les 12 événements publiés (demande, visite, devis, réservation, planification, fin,
 * annulation, avertissement d'impayés, suspension, changement de cause de suspension, reprise,
 * reprogrammation incomplète).
 * Facturation : les 3 événements publiés par billing (facture émise, impayée, réglée).
 * Comptes entreprise (identity) : nouvelle demande (équipe KSP), validation, refus, suspension et
 * réactivation (demandeur).
 * Paiement en ligne (ADR-031) : reçu au payeur (payment.intent.succeeded).
 */
export const EVENT_RULES: EventRules = {
  ...CLEANING_RULES,
  ...BILLING_RULES,
  ...ORGANIZATION_RULES,
  ...PAYMENT_RULES,
};

export const LISTENED_EVENTS = Object.keys(EVENT_RULES) as KspEventType[];
