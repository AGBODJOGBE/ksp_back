import { type KspEventType } from '@ksp/contracts';
import { ACCOUNT_RULES } from './account.rules';
import { BILLING_RULES } from './billing.rules';
import { CLEANING_RULES } from './cleaning.rules';
import { type EventRules } from './event-rules';
import { ORGANIZATION_RULES } from './organization.rules';
import { PAYMENT_RULES } from './payment.rules';
import { WALLET_RULES } from './wallet.rules';

/**
 * Événements écoutés par notification, avec leur règle. Chaque événement a sa file
 * `notification.<événement>` (et ses files `.retry` et `.dlq`).
 *
 * Nettoyage : les 20 événements publiés (demande, envoi groupé, visite, devis, devis du groupe,
 * réservation, planification, planification en lot (ADR-052), fin, annulation, avertissement
 * d'impayés, suspension, changement de cause de suspension, reprise, reprogrammation incomplète ;
 * ADR-053 : rappel avant l'expiration et expiration des devis, passage reporté ou annulé pour être
 * replanifié, visite annulée).
 * Facturation : les 3 événements publiés par billing (facture émise, impayée, réglée).
 * Comptes entreprise (identity) : nouvelle demande (équipe KSP), validation, refus, suspension et
 * réactivation (demandeur).
 * Suppression du compte (identity, ADR-036) : demande enregistrée et annulation (titulaire).
 * Double authentification réinitialisée (identity, ADR-050) : alerte au titulaire.
 * Paiement en ligne (ADR-031) : reçu au payeur (payment.intent.succeeded), recharge du portefeuille
 * comprise (ADR-046).
 * Portefeuille prépayé (ADR-046) : paiement effectué depuis le portefeuille, portefeuille crédité.
 */
export const EVENT_RULES: EventRules = {
  ...CLEANING_RULES,
  ...BILLING_RULES,
  ...ORGANIZATION_RULES,
  ...ACCOUNT_RULES,
  ...PAYMENT_RULES,
  ...WALLET_RULES,
};

export const LISTENED_EVENTS = Object.keys(EVENT_RULES) as KspEventType[];
