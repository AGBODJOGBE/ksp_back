# ADR-032 — Outbox sans blocage, et pas de second paiement avant l'enregistrement du premier

**Statut** : Proposé (corrections de l'essai réel du paiement, 2026-10-31)

## Contexte

Pendant l'essai réel du paiement en ligne (ADR-031), un `payment.intent.failed` en échec de publication (`ECONNRESET`, 1 397 tentatives) a retenu tous les événements suivants de l'outbox de `payment` : le relais publiait dans l'ordre et s'arrêtait au premier échec (ADR-005). Les `payment.intent.succeeded` suivants ne sont donc pas arrivés chez `cleaning` et `billing`, dont le montant dû ne déduisait pas l'argent reçu ; le client se voyait proposer de payer une seconde fois.

L'ordre global de l'outbox n'est de toute façon pas une garantie du dépôt : l'enveloppe ne porte pas de clé d'agrégat, la livraison est « au moins une fois », et un échec chez un consommateur passe par la file `.retry` (ADR-005), ce qui désordonne déjà les messages. Les consommateurs sont idempotents (inbox) et ceux que l'ordre concerne le traitent eux-mêmes (`occurredAt`, ADR-030).

## Décision

1. **Un événement en échec ne bloque plus les suivants** (`libs/platform`, `OutboxRelay` et `SqlOutboxStore`, utilisés par tous les services, dont `billing`). Le relais lit toujours les événements dans l'ordre d'écriture (`created_at`, `id`), mais un échec est imputé à l'événement et le passage continue. **Aucun ordre n'est garanti** entre événements, y compris d'un même agrégat : c'est déjà la règle côté consommateurs.
2. **Délai croissant par événement** : nouvelle tentative après 1 s, puis 2 s, 4 s… plafonnée à 5 minutes (`next_attempt_at`). Le dernier message d'erreur du broker est gardé (`last_error`, 500 caractères, jamais le contenu de l'événement).
3. **Mise de côté** au-delà de 25 tentatives (environ 1 h 30 d'échecs) : `parked_at` est renseigné, l'événement n'est plus repris, et une **alerte** est journalisée (`ALERTE outbox : … mis de côté`, type et identifiant seulement). Il reste **rejouable** une fois la cause corrigée : `SqlOutboxStore.replayParked(ids?)`, ou en SQL dans la base du service :
   `UPDATE outbox SET parked_at = NULL, attempts = 0, next_attempt_at = NULL WHERE parked_at IS NOT NULL AND published_at IS NULL;`
4. **Broker indisponible** : deux échecs de suite arrêtent le passage ; le second n'est pas compté à son événement (le premier l'est, sinon deux événements en échec bloqueraient encore les suivants) et le relais attend (1 s doublée jusqu'à 30 s). Une panne du broker n'use donc qu'une tentative par passage.
5. **Canal de publication rétabli** : un canal RabbitMQ fermé seul (erreur de canal, connexion réinitialisée) est oublié et recréé au prochain usage, au lieu de faire échouer toutes les publications suivantes.
6. **Pas de second paiement avant l'enregistrement du premier** : `cleaning` (`GetMissionAmountDue`) et `billing` (`GetInvoiceAmountDue`) rendent les identifiants des paiements en ligne déjà enregistrés (`online_payment_ids`, ajout au contrat interne). Tant qu'un paiement `succeeded` de l'objet (mission toutes parts confondues, ou facture ; quel que soit le payeur) n'y figure pas, `POST /api/v1/payment/payments` est refusé : **409 `PAYMENT_ALREADY_RECEIVED`**. Le rejeu d'une même clé d'idempotence renvoie toujours le même paiement.
7. **Reste dû exposé aux fronts** : `CleaningPaymentState` porte `remainingDue` (toujours présent) et `depositDue` (acompte encore attendu, `null` s'il n'y en a pas), calculés par `cleaning` en entiers XOF, sur les routes client et du back-office.

## Alternatives écartées

- **Garder l'ordre strict de l'outbox** : un seul événement empoisonné bloque tout le service, sans fin ; c'est le défaut constaté.
- **Ordre par agrégat** (attendre qu'un événement plus ancien du même agrégat parte) : demande une clé d'agrégat dans l'outbox et l'enveloppe, alors qu'aucun consommateur n'en dépend et que la file `.retry` désordonne de toute façon ; à reprendre si un consommateur en a besoin.
- **Déduire du montant dû les paiements réussis non enregistrés** (au lieu de refuser) : `payment` recalculerait un montant que seuls `cleaning` et `billing` connaissent (ADR-031 : `payment` ne calcule rien), avec le risque de se tromper de part (acompte ou solde) ou de compter deux fois un paiement au moment où il est enregistré. Le refus ne fait jamais payer un mauvais montant ; le client réessaie quelques secondes plus tard.
- **File d'attente morte côté broker pour l'outbox** : l'événement n'a justement pas pu atteindre le broker.

## Conséquences

- Migration `outbox_retry` dans chaque service (et le modèle `tools/new-service`) : colonnes `next_attempt_at`, `parked_at`, `last_error`, index partiel du relais recréé sans les événements mis de côté.
- Ordre de déploiement : `cleaning` et `billing` avant `payment` (sinon un `payment` à jour, lisant une liste vide, refuserait tout paiement d'un objet qui a déjà un paiement en ligne réussi).
- À surveiller en exploitation : l'alerte `ALERTE outbox` (événement mis de côté) et le nombre de lignes `parked_at IS NOT NULL`.
- **À valider** : un paiement `amount_mismatch` (argent reçu pour un autre montant, ADR-031) ne bloque pas un nouveau paiement ; la finance tranche. Le bloquer aussi serait plus prudent, mais empêcherait le client de régler tant que la finance n'a pas traité l'écart.
