# Service `wallet`

Grand livre en **double entrée** des fonds que KSP détient pour ses clients (créanciers du
Recouvrement) : encaissements crédités au titulaire moins la commission de KSP, reversements vers un
compte Mobile Money, annulations par écriture inverse. Décision : `docs/adr/0042-grand-livre-wallet.md`.
Contrat gRPC : `contracts/proto/ksp/wallet/v1/wallet.proto`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/wallet-service prisma:deploy   # crée les tables (base « wallet »)
pnpm --filter @ksp/wallet-service dev
```

- gRPC : `localhost:50057`
- Santé : `http://localhost:3107/health/live` et `/health/ready`
- Métriques : `http://localhost:3107/metrics`

## Règles

- Chaque opération est une transaction **équilibrée** (débits = crédits), vérifiée par l'application
  puis par la base à la validation (déclencheur différé). Les écritures sont **immuables** (mise à jour
  et suppression refusées par la base) : une erreur se corrige par une écriture inverse.
- Les **soldes** ne sont jamais saisis : un déclencheur les met à jour à chaque écriture, sous verrou
  du compte, et note `balance_after` sur la ligne.
- Montants entiers XOF ; commission = brut × taux (points de base) / 10 000, **arrondie à l'entier
  inférieur** (KSP ne prélève jamais plus que le taux, le franc restant va au titulaire).
- Comptes : `holder:<user|organization>:<id>` (dû au titulaire), `ksp:collections` (fonds détenus),
  `ksp:commission`, `ksp:payouts_in_transit`. Invariant : fonds détenus = Σ titulaires + commission +
  en transit.

| Opération (WalletService)  | Écritures                                                                  |
| -------------------------- | -------------------------------------------------------------------------- |
| `RecordCollection`         | D collections (brut) / C titulaire (net) / C commission                    |
| `RequestPayout` (retenue)  | D titulaire / C en transit — refusé au-delà du solde (contrôle verrouillé) |
| `payment.payout.completed` | D en transit / C collections                                               |
| `payment.payout.failed`    | D en transit / C titulaire (montant rendu)                                 |
| `ReverseTransaction`       | lignes de l'encaissement, sens inversés (une seule annulation)             |

Idempotence : encaissement et annulation par (appelant, référence), reversement par (appelant, clé) ;
événements de payment par l'inbox, dans la même transaction que l'écriture.

## Portefeuille prépayé des clients (ADR-046)

Second compte par titulaire, `prepaid:<user|organization>:<id>`, distinct des fonds dus au créancier :
dépensable sur la plateforme, **jamais reversé, jamais négatif** (contrôle sous verrou, puis contrainte
en base). Comptes internes `ksp:prepaid_funds` (recharges reçues) et `ksp:service_revenue` (services
payés). Invariant : recharges reçues = Σ portefeuilles + services payés.

| Opération                                              | Écritures                                           |
| ------------------------------------------------------ | --------------------------------------------------- |
| Recharge (`payment.intent.succeeded`, `wallet_top_up`) | D recharges / C portefeuille, une fois par paiement |
| `Debit` (cleaning, billing)                            | D portefeuille / C services — jamais partiel        |
| `Refund`, `cleaning.mission.refunded`                  | écriture inverse du débit, une seule fois           |
| Crédit de la finance (`refund` ou `top_up`)            | D services (ou D recharges) / C portefeuille, motif |

- `WalletAccountService.CreateTopUp` : limites `WALLET_TOP_UP_MIN`/`MAX`, rôle `org_admin` ou
  `org_member` pour une organisation, puis `TopUpPaymentService.CreateTopUpPayment` chez payment (le
  payeur est l'utilisateur transmis dans les métadonnées). Rien n'est écrit avant la confirmation.
- `Debit` : `WALLET_INSUFFICIENT_FUNDS` (montant manquant) ; idempotent par (appelant, clé) ; un débit
  remboursé n'est jamais rejoué (`WALLET_DEBIT_REFUNDED`).
- Écart de montant d'une recharge : rien n'est crédité ; la finance crédite le montant reçu
  (`CreditPrepaidWallet`, `kind: top_up`, `paymentId`), une seule fois par paiement.
- Événements : `wallet.prepaid.debited`, `wallet.prepaid.credited` (outbox, même transaction).
- Appelants : `WALLET_DEBIT_CALLERS` (`cleaning,billing`). Jetons de service : `cleaning` et `billing`
  → audience `wallet`.

## Contrôles de l'argent (ADR-048)

- Espace du titulaire et back-office : `@AllowedCallers('gateway')`.
- Recharge créditée seulement si payment la confirme (`GetTopUpPayment` : réussie, même titulaire, montant reçu).
- Crédit manuel : recharge vérifiée auprès de payment (montant ≤ reçu) ; remboursement plafonné
  (`WALLET_MANUAL_REFUND_MAX`) et justifié (15 caractères) ; au-delà de `WALLET_CREDIT_APPROVAL_THRESHOLD`,
  demande validée par un **autre** membre de la finance (`ApproveManualCredit`) ; MFA de moins de 10 minutes.
- Rapprochement des débits (`WALLET_DEBIT_RECONCILE_INTERVAL_MS`, après `WALLET_DEBIT_CHECK_DELAY_MINUTES`) :
  `GetWalletDebitStatus` de cleaning et billing ; débit jamais enregistré → remboursé, alerte.
- Grand livre verrouillé par la base (solde, `TRUNCATE`, transaction complète, nom effacé après transmission).
  Au déploiement, retirer au rôle applicatif `UPDATE`, `DELETE`, `TRUNCATE` sur `ledger_transactions` et
  `ledger_entries`, `DELETE`, `TRUNCATE` sur `ledger_accounts`.
- Rejeu d'un reversement : empreinte HMAC du numéro (`WALLET_PHONE_HASH_SECRET`, coffre en production).
- `HasPendingObligations` (identity) : solde prépayé, fonds dus ou reversement en cours bloquent la suppression.
- `cleaning.mission.credited` : crédit au prorata d'une mission arrêtée, une fois par `creditId`.

## Reversements

`RequestPayout` retient le montant et crée le reversement dans la même transaction, puis le transmet à
payment (`PayoutService.RequestPayout`, clé et référence = identifiant du reversement wallet). payment
injoignable : le reversement reste `pending_submission`, retransmis toutes les minutes
(`WALLET_PAYOUT_SUBMIT_INTERVAL_MS`). Le numéro complet et le nom du bénéficiaire ne sont gardés que
jusqu'à la transmission (contrainte en base) ; ensuite seuls le numéro masqué et l'opérateur restent.
Issue : événements `payment.payout.completed` / `failed` (émetteur `wallet`).

## Appelants

- `WalletService` : services de `WALLET_LEDGER_CALLERS` (`recovery` au lancement), jeton de service.
- `WalletAccountService` : titulaire connecté via la gateway (`GET /api/v1/wallet/me…`) : son compte
  en contexte personnel, son organisation active sinon.
- `WalletAdminService` : back-office (`/api/v1/admin/wallet/…`), `finance_officer` ou `super_admin`
  avec double authentification.

Jetons de service (identity, `SERVICE_CLIENTS`) : `wallet` → audience `payment` ; `recovery` →
`wallet` et `payment` ; `gateway` → `wallet`.

## Organisation

| Dossier              | Contenu                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `src/domain`         | Écritures du grand livre, commission, reversement                |
| `src/application`    | Un cas d'usage par classe ; ports (grand livre, payment)         |
| `src/infrastructure` | Prisma (soldes et immuabilité tenus par la base), client payment |
| `src/interfaces`     | Contrôleurs gRPC, consommateur des issues de reversement         |
