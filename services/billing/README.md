# Service `billing`

Facturation mensuelle des contrats d'entreprise du Nettoyage (cahier des charges Nettoyage,
partie 10) : version minimale du lot 2 ; factures de commission et reçus des frais du recouvrement
(ADR-064). Contrat gRPC : `contracts/proto/ksp/billing/v1/` ; événements : `contracts/events/billing/`.

## Règles

- **Contrats v1, plus alimentés** : les contrats étaient appris par les événements de cleaning v1
  (`cleaning.booking.confirmed`, `cleaning.request.cancelled`, `cleaning.contract.suspended` /
  `resumed`), retirés par la refonte du Nettoyage (ADR-054) : billing n'écoute plus aucun événement de
  cleaning et ne crée plus de contrat. Les contrats déjà enregistrés restent facturés selon les règles
  ci-dessous, jusqu'à la facture mensuelle v2 sur les séances réalisées (`cleaning.session.completed` et
  `cleaning.session.missed`, lot F, ADR-055) ; les méthodes v2 du contrat gRPC répondent
  `BILLING_NOT_IMPLEMENTED` d'ici là.
- **Libellé** : le nom de la prestation gardé sur le contrat (`serviceName`, ADR-035) est repris dans la
  ligne (« Nettoyage de bureaux — novembre 2026 : … ») ; sans lui, « Prestation de nettoyage — … ».
- **Une facture par mois civil** (heure du Bénin, UTC+1), émise à la fin du mois : le 1er du
  mois suivant à 00:00, heure du Bénin (au premier passage de la tâche planifiée).
- **Prorata des jours** : montant mensuel (`total / durée`) × jours facturables / jours du mois,
  arrondi à l'entier de FCFA. Le premier et le dernier mois partiels sont proratisés ; les jours
  de suspension sont déduits de la même façon. Le dernier mois absorbe l'écart d'arrondi : hors
  suspension, la somme des factures vaut exactement le total. Un contrat annulé est facturé
  jusqu'au jour de l'annulation (exclu), sans absorption. Un mois entièrement suspendu n'est pas
  facturé.
- **En-tête des factures d'organisation** (ADR-028) : raison sociale, adresse, IFU et RCCM lus
  dans identity (`GetOrganizationsByIds`, jeton de service, délai, nouvelle tentative et
  coupe-circuit du kit) au moment de l'émission, et copiés dans la facture : une modification
  ultérieure de la fiche ne la change pas. Pas de TVA. Aucune facture n'est émise sans en-tête :
  identity indisponible → aucune émission, reprise au passage suivant (le passage en impayée
  continue) ; organisation introuvable → contrat reporté et journalisé. Les factures émises
  avant cet en-tête n'en ont pas (`organization` nul).
- **Prestation ponctuelle** (ADR-049) : facturée en une fois, en entier, sur la facture du mois de son
  passage (heure du Bénin) ; rien si elle est annulée ce jour-là ou avant (`one_off`).
- **Montant recalculé sous le verrou** du contrat à l'émission (ADR-049) : un changement enregistré
  entre la lecture et l'émission compte. Les mois s'ajoutent au calendrier du Bénin.
- **Numérotation** `FAC-<année>-<000001>`, continue par année (compteur dans la transaction) ; année de
  la période facturée au Bénin (ADR-049) : la facture de décembre émise en janvier garde son année.
- **Appelants** (ADR-049) : méthodes du client et du back-office réservées à la gateway
  (`BILLING_CALLER_FORBIDDEN` sinon) ; `GetInvoiceAmountDue` à payment, `HasPendingObligations` à
  identity, `WalletDebitCheckService.GetWalletDebitStatus` à wallet (un paiement par portefeuille de la
  facture cite-t-il ce débit ?).
- **Statuts** : `pending_payment` jusqu'à l'échéance (émission + délai réglable, 10 jours),
  puis `overdue` ; `paid` quand les paiements atteignent le total ; `cancelled` réservé.
- **Tâche planifiée interne** (`BILLING_SCHEDULER_INTERVAL_MS`, 15 minutes) : émission puis
  passage en impayée, idempotents (une facture par contrat et par mois, transitions
  conditionnelles).
- **Événements publiés** (outbox) : `billing.invoice.issued`, `billing.invoice.overdue`,
  `billing.invoice.paid` ; consommés par cleaning (avertissement, suspension, déblocage) et
  notification (espace client, e-mail).

- **Suppression d'un compte** (`ksp.common.v1.ObligationService`, ADR-036) : une facture en
  attente de paiement ou impayée du compte (`customer_id`, y compris celle d'une organisation pour
  le compte qui a demandé la prestation) bloque la suppression (`unpaid_invoice`, numéro de
  facture). Seul identity peut appeler (`BILLING_CALLER_FORBIDDEN`). Aucune donnée personnelle à
  effacer à `identity.user.deleted` : la facture ne garde que l'identifiant du compte et l'en-tête de
  l'organisation (document comptable).

## Facture mensuelle des organisations (lot F, CDC Nettoyage v2 partie 11.2, ADR-055)

- **Lignes apprises par événement** : `cleaning.session.completed` et `cleaning.session.missed` d'une
  organisation (`payerKind = organization`) donnent une séance facturable (`billable_sessions`, inbox) ;
  le montant dû vient de l'événement, billing ne rappelle jamais cleaning. Séance d'un particulier :
  ignorée (payée une par une).
- **Émission** le 1er du mois à 00:00 (heure du Bénin), au premier passage de la tâche : une facture
  par organisation (`kind = monthly`, sans contrat) avec ses séances non facturées réalisées avant la fin
  du mois écoulé, groupées par programme puis par lieu, avec la date de chaque séance ; déduction des
  frais de visite en ligne négative ; total nul : émise payée. Mois d'une séance : mois civil à
  Porto-Novo de sa réalisation (ou de l'absence constatée) ; année du numéro : celle de la période. Une
  séance arrivée après l'émission part sur la facture suivante. En-tête figé (identity) : jamais de
  facture sans en-tête (identity indisponible : passage suivant ; organisation introuvable : reportée,
  alerte). Une seule facture par organisation et par mois (index unique partiel, verrou de
  l'organisation) ; lots de 200.
- **Échéance** : émission + délai de règlement (10 jours) ; « impayée » le lendemain de l'échéance
  (`billing.invoice.overdue` v2, impayées de l'organisation celle-ci comprise) ; relances −3, 0, +3,
  +7 jours (`billing.invoice.reminded`, une fois chacune, une relance plus ancienne non envoyée est
  sautée).
- **Règlement** : portefeuille de l'organisation (`PayMyInvoiceFromWallet`), ou crédit du portefeuille
  destiné à la facture (`wallet.prepaid.credited` v2, `forObject` « billing_invoice », versions 1 et 2
  lues) débité aussitôt ; paiement hors ligne refusé sur une facture v2 (`wallet_path_required`).
  Facture soldée : `billing.invoice.paid` v2 avec `settledBy` (paiement, avoir, annulation).
- **Avoirs** (`IssueCreditNote` réservé à cleaning, `IssueAdminCreditNote` finance avec double
  authentification récente) : numéro `AV-<année>-<000001>`, imputés sur le reste dû puis crédités au
  portefeuille (wallet.Credit, billing à ajouter à `WALLET_CREDIT_CALLERS`), jamais au-delà du total ;
  idempotents par (émetteur, clé). **Annulation** d'une facture ouverte sans paiement (cas d'usage
  seul : pas de méthode au contrat), séances remises à facturer si demandé.
- **Événements v2** (RV-98) : une facture v2 publie `billing.invoice.issued`, `.overdue` et `.paid` en
  version 2, sans `contractId` ; une facture v1 garde la version 1.
- **Tâche planifiée** (`BILLING_SCHEDULER_INTERVAL_MS`) : émission, impayées, relances, sous un verrou
  consultatif PostgreSQL (`pg_try_advisory_xact_lock`) : une seule réplique fait le passage.

## Facturation du recouvrement (ADR-060 décision 11, R-CO-05 ; ADR-064)

- **Encaissements appris par événement** : `recovery.payment.collected` (inbox) donne une ligne par
  encaissement (`commission_collections`) ; montant brut, commission et mode de règlement viennent de
  l'événement, billing ne recalcule jamais la commission.
- **Facture de commission** le 1er du mois à 00:00 (heure du Bénin), au premier passage de la tâche : une
  par créancier (compte ou organisation) avec ses encaissements non facturés reçus avant la fin du mois
  écoulé ; un encaissement arrivé après l'émission part sur la facture suivante. Une ligne par
  encaissement (dossier, date, origine, brut, commission, mode de règlement), figée
  (`commission_invoice_lines`) ; totaux encaissé, commission retenue, à débiter, totale. **Hors taxe** :
  aucune ligne de TVA. Numéro `FCR-<année>-<000001>` (compteur `series_counters`, année du mois facturé).
  En-tête d'une organisation créancière copié d'identity à l'émission, comme les factures du Nettoyage.
  Publie `billing.commission_invoice.issued` (identifiants et montants).
- **Règlement** : commission `deducted` déjà réglée ; commission `invoiced` (paiement reçu directement
  par le créancier) débitée du portefeuille prépayé du créancier (`wallet.Debit`, objet
  `billing_commission_invoice`, clé `billing_commission_invoice:<id>`) au passage de l'émission. Solde
  insuffisant : facture due, montant manquant noté, nouvel essai après
  `BILLING_COMMISSION_DEBIT_RETRY_MS` (un jour) ; autre échec de wallet : un quart d'heure. Sans
  commission à débiter : réglée dès l'émission.
- **Nouvel essai dès un crédit** : à `wallet.prepaid.credited` (recharge, remboursement, crédit de la
  finance ou d'un service), les factures de commission dues du titulaire crédité sont débitées tout de
  suite, même clé, sous le verrou consultatif de la tâche (`billing.commission_billing`) : jamais deux
  passages de débit en même temps. Verrou pris : le message revient par la file de reprise. Seul
  abonnement de billing à cet événement : `WalletCreditEventsConsumer` (facture du lot F visée par
  `forObject`, puis commissions dues).
- **Reçus des frais** : `wallet.prepaid.debited` de `recovery` pour `recovery_case_fee` ou
  `recovery_study_fee` donne un reçu `RFD-<année>-<000001>` (année du paiement), un par transaction du
  portefeuille ; un remboursement ultérieur ne l'annule pas. Tout autre débit est ignoré.
- **Lecture** (gateway seule) : `ListMyCommissionInvoices`, `GetMyCommissionInvoice`, `ListMyFeeReceipts`
  (compte, ou organisation active, tout membre) ; `ListCommissionInvoices`, `GetCommissionInvoice` au
  back-office (`finance_officer`, `super_admin`, `recovery_admin` en lecture ; double authentification de la
  session). Pas de PDF.
- **Suppression d'un compte** : une facture de commission due du compte bloque (`unpaid_invoice`, numéro
  FCR) ; celle d'une organisation seulement si identity la désigne (`organization_id`).
- **Tâche planifiée** : `CommissionBillingSchedulerService`, même intervalle, verrou consultatif propre
  (`billing.commission_billing`).

## Paiement par le portefeuille prépayé (ADR-046)

`BillingService.PayMyInvoiceFromWallet` (`POST /api/v1/billing/invoices/{id}/pay`) : portefeuille de
l'organisation (membre `org_admin` ou `org_member`) ou du client ; reste dû débité en entier par wallet
puis enregistré (moyen `wallet`, auteur = le membre) ; payée au total : `billing.invoice.paid`. Facture
réglée entre-temps : débit remboursé aussitôt. Configuration : `WALLET_GRPC_URL` ; jeton de service
`billing` → `wallet`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/billing-service prisma:migrate   # crée les tables
pnpm --filter @ksp/billing-service dev
```

- gRPC : `localhost:50054`
- Santé : `http://localhost:3104/health/live` et `/health/ready`
- Métriques : `http://localhost:3104/metrics`
- identity : `IDENTITY_GRPC_URL` (`localhost:50051`) ; jeton de service (`IDENTITY_TOKEN_URL`,
  `SERVICE_CLIENT_SECRET`) obligatoire en production. Entrée `SERVICE_CLIENTS` d'identity :
  `billing` avec l'audience `identity` (`keys:service-client billing identity`).

## Organisation

| Dossier              | Contenu                                                    |
| -------------------- | ---------------------------------------------------------- |
| `src/domain`         | Règles métier, sans aucune dépendance technique            |
| `src/application`    | Un cas d'usage par classe                                  |
| `src/infrastructure` | Base de données, RabbitMQ, appels vers les autres services |
| `src/interfaces`     | Contrôleurs gRPC et consommateurs d'événements             |
