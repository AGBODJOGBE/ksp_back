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
 * Nettoyage (refonte v2, ADR-054) : les six événements v1 réécrits sur place (demande annulée,
 * visite planifiée ou annulée, devis envoyé, rappel avant l'expiration, devis expiré) ; les autres
 * événements v2 seront écoutés avec leurs lots (lot G, abonnements déclarés avec D40).
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

/**
 * Versions de l'enveloppe lues par événement ; version 1 seule pour les autres. Le portefeuille
 * crédité est lu en versions 1 et 2 (RV-101) : wallet ne publiera plus que la version 2 une fois
 * tous ses consommateurs livrés ; tout message v1 est un message v2 valide.
 */
export const LISTENED_EVENT_VERSIONS: { readonly [T in KspEventType]?: readonly number[] } = {
  'wallet.prepaid.credited': [1, 2],
};
