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

## Organisation

| Dossier              | Contenu                                                         |
| -------------------- | --------------------------------------------------------------- |
| `src/domain`         | Machine à états du paiement, choix du montant dû                |
| `src/application`    | Un cas d'usage par classe ; ports (prestataire, montants dus…)  |
| `src/infrastructure` | Prisma, FedaPay, prestataire simulé, gRPC vers cleaning/billing |
| `src/interfaces`     | Contrôleurs gRPC (client, webhook, back-office)                 |
