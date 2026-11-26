# ADR-064 — Factures de commission et reçus des frais du recouvrement dans `billing`

**Statut** : Accepté (2026-11-23). Décisions validées par le responsable le 23/11/2026.

## Contexte

ADR-060 (décision 11) confie à `billing` la facture mensuelle de commission de chaque créancier
(R-CO-05) et le reçu des frais de dossier. `recovery` publie `recovery.payment.collected` pour chaque
encaissement imputé : montant brut, commission calculée selon la règle figée dans le mandat (ADR-062)
et mode de règlement — `deducted` quand la commission est retenue sur l'encaissement, `invoiced` quand
le débiteur a payé directement le créancier, qui doit alors la commission à KSP. Les frais de dossier
et le forfait d'étude sont débités du portefeuille prépayé du créancier (`wallet.Debit`, ADR-046), ce
que `wallet` publie dans `wallet.prepaid.debited`.

Le contrat `Invoice` de `billing` ne peut pas porter ces documents : son numéro suit `^FAC-`, son
`source` vaut `cleaning`, et une nouvelle valeur d'énumération dans une réponse est une rupture refusée
par la CI (oasdiff). `billing` ne produit aucun PDF aujourd'hui.

## Décision

1. **Hors taxe** : la facture de commission n'a aucune ligne de TVA ; ses montants sont affichés
   « hors taxe » (champ `amountsExcludingTax`, toujours vrai).
2. **Séries de numéros distinctes** de celles du Nettoyage (`FAC-`) et des avoirs (`AV-`) :
   `FCR-AAAA-NNNNNN` pour les factures de commission (année du mois facturé, au Bénin : la facture de
   décembre émise en janvier garde son année) et `RFD-AAAA-NNNNNN` pour les reçus de frais (année du
   paiement, au Bénin). Chacune est continue par année : compteur par série et par année
   (`series_counters`), tiré dans la transaction de l'émission, sans trou.
3. **Facture mensuelle** : le 1er de chaque mois à 00:00, heure du Bénin (Africa/Porto-Novo), au
   premier passage de la tâche planifiée de `billing` (verrou consultatif propre), pour le mois
   écoulé. Une facture par créancier (compte ou organisation) qui a au moins un encaissement non
   facturé reçu avant la fin du mois ; un encaissement arrivé après l'émission part sur la facture
   suivante, comme les séances du Nettoyage. Une ligne par encaissement, figée : numéro du dossier,
   date, origine, montant brut, commission, mode de règlement. Totaux : encaissé, commission retenue,
   commission à débiter, commission totale. Une seule facture par créancier et par mois (index unique,
   verrou du créancier). `billing` ne recalcule jamais la commission : elle vient de l'événement.
4. **Règlement de la commission `invoiced`** : `billing` la débite automatiquement du portefeuille
   prépayé du créancier au passage de l'émission (`wallet.Debit`, objet `billing_commission_invoice`,
   objectId = id de la facture, clé d'idempotence stable `billing_commission_invoice:<id>` : un débit
   déjà fait est rendu tel quel par `wallet`). Solde insuffisant : la facture reste due, le montant
   manquant est noté, et `billing` réessaie après un délai réglable (`BILLING_COMMISSION_DEBIT_RETRY_MS`,
   un jour par défaut) jusqu'au paiement ; tout autre échec de `wallet` est réessayé un quart d'heure
   plus tard. La finance voit au back-office l'état du débit (tentatives, dernier échec, montant
   manquant, prochain essai). Une commission `deducted` s'affiche comme déjà réglée ; une facture sans
   part `invoiced` est réglée dès son émission.
   **Nouvel essai dès un crédit du portefeuille** (décision du 2026-11-25) : à la réception de
   `wallet.prepaid.credited` (recharge, remboursement, crédit de la finance ou d'un service), les
   factures de commission encore dues du titulaire crédité sont débitées tout de suite, sans attendre
   le prochain essai, avec la même clé d'idempotence (`billing_commission_invoice:<id>`) : `wallet`
   rend un débit déjà fait, jamais un second. Ce nouvel essai prend le verrou consultatif de la tâche
   planifiée (`billing.commission_billing`) : tâche et nouvel essai ne débitent jamais en même temps,
   d'une réplique à l'autre ; les factures sont relues sous le verrou. Verrou pris (passage en cours) :
   le message revient par la file de reprise (10 s, puis délais croissants). Aucune facture due : rien,
   sans verrou. Un échec suit la règle ci-dessus (solde encore insuffisant : prochain essai un jour plus
   tard). L'événement reçu deux fois n'a pas d'effet de plus : une facture réglée n'est plus due.
5. **Reçus des frais de dossier** : émis à partir de `wallet.prepaid.debited` quand `service` vaut
   `recovery` et `objectType` vaut `recovery_case_fee` (frais de dossier) ou `recovery_study_fee`
   (forfait d'étude). Convention suivie par `recovery` : objectId = id du dossier, libellé « Frais de
   dossier RC-… » ou « Forfait d'étude du dossier RC-… » (le numéro du dossier est lu dans le libellé).
   Un reçu par débit, idempotent par transaction du portefeuille ; un remboursement ultérieur
   n'annule pas le reçu. Tout autre débit est ignoré.
6. **En-tête d'une organisation créancière** copié d'`identity` à l'émission, comme les factures du
   Nettoyage (ADR-028) : jamais de facture d'organisation sans en-tête ; `identity` indisponible, les
   comptes sont facturés et les organisations au passage suivant ; organisation introuvable, facture
   reportée avec une alerte.
7. **Contrat, par ajout seulement** : documents propres (`CommissionInvoice`, `FeeReceipt`), hors du
   message `Invoice`. Méthodes ajoutées à `BillingService` (`ListMyCommissionInvoices`,
   `GetMyCommissionInvoice`, `ListMyFeeReceipts` : compte, ou organisation active, tout membre) et à
   `BillingAdminService` (`ListCommissionInvoices`, `GetCommissionInvoice` : `finance_officer`,
   `super_admin`, et `recovery_admin` en lecture, double authentification de la session). Routes :
   `GET /api/v1/billing/commission-invoices`, `GET /api/v1/billing/commission-invoices/{id}`,
   `GET /api/v1/billing/receipts`, `GET /api/v1/admin/billing/commission-invoices` et
   `GET /api/v1/admin/billing/commission-invoices/{id}`. La nature d'un reçu est une chaîne documentée,
   pas une énumération : une nouvelle nature de frais ne rompra pas le contrat.
8. **Événement `billing.commission_invoice.issued` v1**, sans aucune donnée personnelle : id, numéro,
   créancier { type, id }, mois AAAA-MM, totaux, date d'émission. `recovery` s'en servira pour ses
   relevés mensuels ; aucun consommateur n'est déclaré aujourd'hui.
9. **Obligations** : une facture de commission due bloque la suppression du compte créancier, comme une
   facture impayée du Nettoyage (`unpaid_invoice`, numéro FCR). Celle d'une organisation ne compte que si
   `identity` désigne l'organisation (`organization_id`) : l'organisation survit au départ d'un membre,
   comme son portefeuille (ADR-048).
10. **Pas de PDF** pour l'instant : les données passent par l'API.

## Alternatives écartées

- **Étendre le contrat `Invoice`** (numéro `FCR-`, `source` `recovery`) : nouvelle valeur d'énumération
  dans une réponse, refusée par la CI ; les clients du Nettoyage verraient des factures qu'ils ne
  savent pas lire.
- **Même série que les factures du Nettoyage** : mélange deux activités dans une numérotation continue ;
  refusé par le responsable.
- **Commission `invoiced` payée par le créancier à la main** (bouton « payer ») : un oubli laisse la
  commission impayée ; le débit automatique avec nouvel essai suit le modèle des frais de dossier.
- **Reçu demandé par `recovery` par appel gRPC** : couplage d'un appel de plus après chaque débit ;
  l'événement du portefeuille porte déjà tout ce qu'il faut.
- **Commission recalculée par `billing`** : deux calculs d'une même règle divergeraient ; la règle est
  figée dans le mandat et appliquée par `recovery` (ADR-062).

## Conséquences

- `billing` : migration `0010_recovery_commission_invoices` (encaissements, factures de commission et
  leurs lignes, reçus, compteurs par série) ; abonnements à `recovery.payment.collected` et
  `wallet.prepaid.debited` déclarés dans `EVENT_CONSUMERS` ; tâche planifiée propre sous verrou
  consultatif ; variable `BILLING_COMMISSION_DEBIT_RETRY_MS`. `wallet.prepaid.credited`, déjà écouté
  pour le lot F (déjà dans `EVENT_CONSUMERS`), relance aussi le débit des commissions dues : un seul
  abonnement (`WalletCreditEventsConsumer`), une file par service et par événement.
- `wallet` : `billing` figure déjà dans `WALLET_DEBIT_CALLERS` ; les débits de commission apparaissent
  au relevé du créancier (« Commission de recouvrement — facture FCR-… ») et dans
  `wallet.prepaid.debited` (service `billing`, ignoré par le reçu de frais).
- `gateway` : cinq routes, rôles et double authentification repris du contrat.
- `recovery` doit garder sa convention de débit (objet = dossier, libellé avec le numéro RC-…) pour que
  le reçu porte le numéro du dossier.

## À valider

- Commission due par une organisation : faut-il prévenir ses administrateurs à chaque échec du débit
  (événement à publier pour `notification`) ?
- Mentions légales de la facture hors taxe (régime fiscal de KSP) à confirmer par le comptable avant
  le lancement, et PDF des factures et reçus.
