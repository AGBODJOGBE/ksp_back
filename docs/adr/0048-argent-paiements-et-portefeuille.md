# ADR-048 — Argent : une page payable par objet, FedaPay en production, portefeuille contrôlé

**Statut** : Proposé (corrections issues de la revue de code, 2026-11-10)

## Contexte

La revue du code de `payment` et `wallet` a relevé des chemins par lesquels un client pouvait payer deux
fois, de l'argent pouvait être crédité sans preuve, ou une erreur du prestataire était mal traitée :
plusieurs pages payables pour un même objet, page FedaPay « expirée » chez nous mais encore payable chez
lui, sandbox autorisé en production, méthodes « utilisateur » appelables par n'importe quel service, crédit
manuel du portefeuille sans contrôle, recharge créditée sur la foi d'un événement, débit sans paiement
enregistré jamais rapproché, reversement refusé relancé sans fin, grand livre moins verrouillé que
l'ADR-042, rejeu d'un reversement jugé sur un numéro masqué, compte supprimable avec un solde.

## Décision

### payment

1. **Une seule page payable par objet** à montant dû (mission, toutes parts ; facture ; tous payeurs) et
   par lien de paiement : index uniques partiels `(subject_type, subject_id) WHERE status = 'pending'`
   (missions et factures) et `(payment_link_id) WHERE status = 'pending'` (migration `0007`, qui annule
   les doublons déjà présents, sans événement). À la création : la page du même payeur, même part, même
   montant est **réutilisée** ; une autre page en attente est relue chez le prestataire (close, elle ne
   bloque plus) ; sans transaction, ou du même payeur pour la même part avec un montant changé, elle est
   remplacée **si elle peut être annulée** ; sinon **409 `PAYMENT_CHECKOUT_OPEN`** (`details.expiresAt`).
   Une page encore payable d'un autre payeur ou d'une autre part n'est jamais annulée. Deux envois
   simultanés : l'index n'en laisse passer qu'un, l'autre réutilise ou reçoit 409. Les recharges du
   portefeuille (nouvel argent) restent hors de cette règle.
2. **Page non annulable (FedaPay)** : l'API publique ne documente ni annulation de transaction ni durée de
   validité de la page pour le marchand (ADR-031, à valider avec le compte). Le paiement reste donc
   `pending` — page réutilisée, aucune autre ouverte pour l'objet — pendant
   `PAYMENT_CHECKOUT_VALIDITY_MINUTES` (24 h par défaut), au lieu des 30 minutes réservées aux
   prestataires qui savent annuler (simulé). Une annulation impossible (non prévue, refusée ou en panne)
   ne clôt jamais un paiement avant cette validité. À la clôture d'une page non annulée : alerte
   `checkoutClosedUnconfirmed`. La fenêtre de relecture des réussites tardives
   (`PAYMENT_LATE_SUCCESS_WINDOW_HOURS`) doit couvrir au moins cette validité (contrôlé au démarrage) ; la
   notification signée reste traitée sans limite de temps. Un paiement tardif sur un objet déjà réglé est
   enregistré en trop-perçu par cleaning et billing (ADR-049).
3. **Production** : `FEDAPAY_ENVIRONMENT=live`, clé `sk_live_…`, `FEDAPAY_API_URL` vide ou HTTPS d'un hôte
   `*.fedapay.com` ; en tout environnement, la clé doit correspondre à l'environnement (`sk_sandbox_` /
   `sk_live_`).
4. **Méthodes réservées à la gateway** : `@AllowedCallers('gateway')` (kit, ADR-050) sur les contrôleurs de
   l'espace client, de la page publique d'un lien, du webhook et des back-offices (paiements,
   reversements). Les méthodes internes gardent leurs appelants (émetteurs de liens et de reversements,
   wallet pour les recharges, identity pour les obligations).
5. **Reversement refusé** (HTTP 4xx hors 408 et 429) à la création ou au lancement : échec définitif
   `provider_rejected` (gardé dans payment, publié `provider_failed` : le schéma v1 de
   `payment.payout.failed` ne change pas) et alerte ; jamais réessayé. Un reversement est noté
   `processing` **avant** l'appel de lancement : il n'est plus jamais relancé, seulement relu (lancement
   sans réponse : alerte `payoutStartUncertain`, la relecture tranche).
6. **Relecture d'une recharge par wallet** : `TopUpPaymentService.GetTopUpPayment` (réservé à wallet) rend
   le paiement et le **montant reçu** confirmé par le prestataire en XOF (`received_amount`, migration
   `0008` : celui du paiement réussi, ou le montant approuvé d'un écart en XOF ; absent sinon).

### wallet

7. **Méthodes réservées à la gateway** : `@AllowedCallers('gateway')` sur `WalletAccountService` et
   `WalletAdminService`.
8. **Crédit automatique d'une recharge** (`payment.intent.succeeded`) : la recharge est relue chez payment ;
   rien n'est crédité si elle n'est pas réussie, pour ce titulaire, avec ce montant reçu (alerte) ;
   payment injoignable : l'événement est réessayé.
9. **Crédit manuel contrôlé** : recharge (`top_up`) vérifiée auprès de payment (recharge du titulaire, argent
   reçu, montant ≤ reçu, sinon `WALLET_TOP_UP_NOT_VERIFIED`) ; remboursement (`refund`) plafonné
   (`WALLET_MANUAL_REFUND_MAX`, 100 000 FCFA, sinon `WALLET_CREDIT_LIMIT_EXCEEDED`) et justifié (motif de
   15 caractères au moins). Au-delà de `WALLET_CREDIT_APPROVAL_THRESHOLD` (50 000 FCFA), **double
   validation** : la demande est enregistrée (`manual_credit_requests`, migration `0006`), rien n'est
   écrit ; un **autre** membre de la finance la valide (`ApproveManualCredit`, sinon
   `WALLET_APPROVAL_BY_REQUESTER`) ; l'écriture garde l'auteur de la demande, la demande garde le valideur.
   Double authentification de moins de 10 minutes pour créditer et valider (comme la gateway). Routes :
   `GET /api/v1/admin/wallet/credit-requests`, `POST /api/v1/admin/wallet/credit-requests/{id}/approve` ;
   la réponse du crédit porte `pendingRequest` au-delà du seuil.
10. **Rapprochement des débits** : toutes les 10 minutes (`WALLET_DEBIT_RECONCILE_INTERVAL_MS`), les débits
    du portefeuille de plus de 30 minutes (`WALLET_DEBIT_CHECK_DELAY_MINUTES`), ni vérifiés ni remboursés,
    sont soumis au service qui les a faits (`WalletDebitCheckService.GetWalletDebitStatus` de cleaning et de
    billing, réservé à wallet) : enregistré → noté vérifié (`debit_checks`, migration `0008`) ; non
    enregistré → remboursé une fois au portefeuille, avec une alerte ; service injoignable → relu au passage
    suivant, jamais remboursé à l'aveugle.
11. **Grand livre verrouillé par la base** (migration `0007`) : un solde ne change que depuis le déclencheur
    des lignes (une mise à jour directe est refusée), les autres colonnes d'un compte ne changent jamais, un
    compte ne se supprime pas ; `TRUNCATE` refusé sur les trois tables ; contrôle différé de chaque
    transaction (au moins deux lignes, équilibrée, montant > 0, débits = brut ou montant, brut = net +
    commission) ; `beneficiary_name` effacé après la transmission, comme le numéro. Le rôle applicatif
    perd en plus `UPDATE`, `DELETE` et `TRUNCATE` sur les transactions et les lignes, `DELETE` et
    `TRUNCATE` sur les comptes (commandes dans la migration, à appliquer au déploiement).
12. **Rejeu d'un reversement** jugé sur l'**empreinte** du numéro complet (HMAC-SHA256 à clé secrète
    `WALLET_PHONE_HASH_SECRET`, refusée par défaut en production ; colonne `beneficiary_phone_hash`,
    migration `0005`), plus sur le numéro masqué. Reversements antérieurs : comparés comme avant.
13. **Suppression d'un compte** : wallet implémente `ksp.common.v1.ObligationService.HasPendingObligations`
    (identity seulement) : solde prépayé > 0, fonds dus (ou dette envers KSP), reversement en cours du
    compte « user » bloquent. identity interroge wallet par défaut (`OBLIGATION_SERVICES`).
14. **Crédit au prorata d'une mission arrêtée** (`cleaning.mission.credited`, ADR-049) : écriture `refund` au
    portefeuille du client, une seule fois par `creditId` (référence propre à cleaning, inbox).

## Compatibilité

- Contrats gRPC : ajouts seulement (`GetTopUpPayment`, `ListManualCreditRequests`, `ApproveManualCredit`,
  champ `pending_request`, codes d'erreur commentés). Événements : aucun schéma modifié.
- REST : deux routes ajoutées ; la réponse du crédit manuel devient `WalletCredit` **ou**
  `WalletCreditPending` (au-delà du seuil seulement) : le back-office doit savoir afficher la demande en
  attente et sa validation.
- Comportement visible : une page FedaPay reste réutilisable jusqu'à 24 h ; un second payeur (ou l'autre
  part d'une mission) reçoit 409 tant qu'elle peut être payée.

## Ordre de déploiement

1. `payment` (migrations `0007`, `0008` ; `GetTopUpPayment`) — avant wallet, qui l'appelle à chaque crédit.
2. `cleaning` et `billing` (ADR-049 : `GetWalletDebitStatus`, `cleaning.mission.credited`).
3. `wallet` (migrations `0005` à `0008` ; `WALLET_PHONE_HASH_SECRET` au coffre ; `CLEANING_GRPC_URL`,
   `BILLING_GRPC_URL`) puis retrait des droits du rôle applicatif ; jetons de service `wallet → cleaning`,
   `wallet → billing`.
4. `identity` (wallet dans `OBLIGATION_SERVICES`) et `gateway` (routes de validation), puis le back-office.

## À valider

- Durée de validité d'une page FedaPay et existence d'une annulation marchand (avec le compte de test) :
  `PAYMENT_CHECKOUT_VALIDITY_MINUTES` à ajuster.
- Plafond d'un remboursement manuel (100 000 FCFA) et seuil de double validation (50 000 FCFA).
- Délai avant rapprochement d'un débit (30 minutes) et remboursement automatique plutôt qu'une simple alerte.
- Comptes d'organisation : leur solde ne bloque pas la suppression du compte d'un membre.
