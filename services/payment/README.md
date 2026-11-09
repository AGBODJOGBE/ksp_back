# Service `payment`

Paiement en ligne par Mobile Money (MTN, Moov) via FedaPay : acompte ou solde d'une mission du
Nettoyage, reste dû d'une facture mensuelle. Décision : `docs/adr/0031-paiement-mobile-money-fedapay.md`.
Contrat gRPC : `contracts/proto/ksp/payment/v1/`. Événements : `contracts/events/payment/`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/payment-service prisma:deploy   # crée les tables (base « payment »)
pnpm --filter @ksp/payment-service dev
```

- gRPC : `localhost:50055`
- Santé : `http://localhost:3105/health/live` et `/health/ready`
- Métriques : `http://localhost:3105/metrics`

Sans clés FedaPay, `PAYMENT_PROVIDER=simulated` : la page de paiement est celle du portail
(`PAYMENT_SIMULATION_CHECKOUT_URL?paymentId=…`), qui appelle `POST /api/v1/payment/payments/{id}/simulate`
(`{ "outcome": "succeeded" }` ou `"failed"`). Interdit en production.

Avec FedaPay : `PAYMENT_PROVIDER=fedapay`, `FEDAPAY_ENVIRONMENT=sandbox`, `FEDAPAY_SECRET_KEY` et
`FEDAPAY_WEBHOOK_SECRET` (coffre), et l'adresse du webhook déclarée chez FedaPay :
`https://<api>/api/v1/payment/webhooks/fedapay`.

## Parcours

1. `CreatePayment` : montant dû lu dans cleaning (`GetMissionAmountDue`) ou billing
   (`GetInvoiceAmountDue`), payeur vérifié, transaction et page de paiement chez le prestataire.
2. Le client paie sur la page du prestataire, puis revient sur le portail.
3. Confirmation par le prestataire seulement : notification signée (webhook) puis relecture de la
   transaction ; à défaut, relecture au passage de `GetMyPayment` ou par le rapprochement planifié.
4. `payment.intent.succeeded` (outbox) : cleaning ou billing enregistre le paiement ; notification
   envoie le reçu.

Tant que cleaning ou billing n'a pas enregistré un paiement réussi, un nouveau paiement du même objet
est refusé (409, ADR-032) : `PAYMENT_ALREADY_RECEIVED` (« réessayez ») pendant
`PAYMENT_UNRECORDED_GRACE_MINUTES` (15 par défaut) après la réussite, puis
`PAYMENT_RECONCILIATION_PENDING` (contacter le support) avec une ligne `ALERTE paiement` dans le
journal. Cause habituelle : événement retenu dans l'outbox de payment ; s'il est mis de côté, le
rejouer avec `pnpm outbox:replay payment`.

Un paiement `amount_mismatch` (montant ou devise approuvés différents) bloque lui aussi tout nouveau
paiement du même objet, quel que soit le payeur ou la part, jusqu'à ce que la finance l'ait traité
(ADR-032, décision 10) : `PAYMENT_UNDER_REVIEW` (409, contacter le support), avec une ligne
`ALERTE paiement` à chaque refus. La finance traite l'écart au back-office
(`POST /api/v1/admin/payment/payments/{id}/resolve-mismatch`, RPC `ResolveAmountMismatch`, note
obligatoire) : date, auteur et note sont enregistrés, le statut reste `amount_mismatch`, le blocage est
levé. Écarts à traiter : `GET /api/v1/admin/payment/payments?underReview=true`.

## Recharge du portefeuille prépayé (ADR-046)

`TopUpPaymentService.CreateTopUpPayment`, réservé à wallet : objet `wallet_top_up` (identifiant :
organisation active du payeur, sinon le payeur), montant choisi par le client et contrôlé par wallet,
page réutilisée pour le même montant, remplacée sinon. Confirmation par le chemin commun ; la réussite
publie `payment.intent.succeeded`, sur lequel wallet crédite le portefeuille. Les refus d'ADR-032 liés à
un montant dû ne s'appliquent pas. `POST /api/v1/payment/payments` (mission, facture) est **déprécié**
au profit du portefeuille, mais reste fonctionnel.

## Liens de paiement (ADR-040)

Pour un payeur **sans compte KSP** (débiteur du Recouvrement). Un service émetteur autorisé
(`PAYMENT_LINK_ISSUERS`, `recovery` au lancement, jeton de service) crée le lien par
`PaymentLinkService.CreatePaymentLink` (objet `subjectType`/`subjectId` à lui, montant XOF fixe,
bénéficiaire affiché, libellé, échéance, expiration de 1 heure à 180 jours, nom et téléphone du
payeur facultatifs, jamais journalisés) et reçoit l'adresse `<PAYMENT_LINK_BASE_URL>/<jeton>` à
envoyer par SMS ou WhatsApp. Jeton : HMAC-SHA256 de l'identifiant (secret `PAYMENT_LINK_TOKEN_SECRET`),
43 caractères ; seule son empreinte est en base. Révocation : `RevokePaymentLink`.

Page publique (gateway) : `GET /api/v1/payment/links/{token}` (résumé sans donnée personnelle) et
`POST /api/v1/payment/links/{token}/pay` (`Idempotency-Key`). Chaque essai est un paiement ordinaire
sans payeur connecté (`payment_link_id`), confirmé par le prestataire. Réussite :
`payment.link.paid` (jamais `payment.intent.succeeded`). Refus : objet déjà payé (409
`PAYMENT_LINK_ALREADY_PAID`), écart de montant non traité (409 `PAYMENT_UNDER_REVIEW`), lien révoqué
ou expiré (422), plus de `PAYMENT_LINK_ATTEMPTS_PER_HOUR` essais par heure (429).

## Reversements (ADR-041)

`PayoutService.RequestPayout` (émetteurs `PAYMENT_PAYOUT_ISSUERS`, `wallet` au lancement) : montant,
bénéficiaire Mobile Money (numéro +229, opérateur `mtn`/`moov`/`celtiis`, nom), référence, clé
d'idempotence. `PAYOUT_PROVIDER=manual` (défaut) : la finance fait le virement puis le confirme
(`POST /api/v1/admin/payment/payouts/{id}/confirm`, référence du virement) ou le déclare en échec
(`…/fail`, raison) ; `fedapay` : créé puis lancé chez FedaPay, relu par le rapprochement et par les
notifications `payout.*` (à valider avec le compte avant activation). Issues :
`payment.payout.completed`, `payment.payout.failed` (code seulement, ni numéro ni raison).

## Suppression d'un compte (ADR-036)

`ksp.common.v1.ObligationService` : un paiement du compte en attente (`pending_payment`) ou en écart
de montant pas encore traité par la finance (`payment_under_review`) bloque la suppression, en son
nom ou pour une organisation (le payeur est la personne). Seul identity peut appeler
(`PAYMENT_CALLER_FORBIDDEN`). Aucune donnée personnelle à effacer à `identity.user.deleted` : le
paiement ne garde que l'identifiant du payeur (pièce comptable).

## Organisation

| Dossier              | Contenu                                                         |
| -------------------- | --------------------------------------------------------------- |
| `src/domain`         | Machine à états du paiement, choix du montant dû                |
| `src/application`    | Un cas d'usage par classe ; ports (prestataire, montants dus…)  |
| `src/infrastructure` | Prisma, FedaPay, prestataire simulé, gRPC vers cleaning/billing |
| `src/interfaces`     | Contrôleurs gRPC (client, webhook, back-office)                 |
