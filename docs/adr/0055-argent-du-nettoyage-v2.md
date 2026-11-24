# ADR-055 — Argent du Nettoyage v2 : le wallet comme seul chemin, paiement après chaque séance, facture mensuelle sur les séances réalisées

**Statut** : Proposé (2026-11-19)

## Contexte

En v1, une mission se payait de quatre façons (portefeuille, page Mobile Money propre à la mission,
espèces cochées par le superviseur, facture pour une entreprise), en acompte ou en totalité, avant ou
après (ADR-031, 046, 049). Deux chemins vers le même objet ont demandé des protections contre le double
paiement (ADR-032, 048), et l'arrêt d'une mission récurrente un crédit au prorata (ADR-049). L'entreprise
était facturée au prorata des jours de son contrat (ADR-025), suspension déduite.

Le cahier des charges v2 (parties 3, 7.2, 11 et 12) simplifie : **un seul chemin pour l'argent, le
wallet** de chaque compte et de chaque organisation (ADR-046), un paiement après chaque séance pour le
particulier, une facture mensuelle de ce qui a été fait pour l'entreprise, des avoirs pour corriger.

## Décision

1. **Tout débit passe par `wallet`** (`WalletService.Debit`, ADR-046 : jamais partiel, jamais négatif,
   clé d'idempotence propre à l'objet). Objets débités par le Nettoyage : frais de visite
   (`cleaning_visit_fee`, clé = demande) et séance (`cleaning_session`, clé = séance, R-PP-01). Chaque
   débit porte un libellé lisible (« Nettoyage — séance 3/15 », R-WL-03). Un même objet n'est jamais
   débité deux fois.
2. **Mobile Money (ou carte) crédite puis débite** (R-WL-05, R-PE-04). Quand le solde manque, le client
   paie par `payment` une **recharge rattachée à l'objet** (montant exact de l'objet, à valider) ; à la
   confirmation, `wallet` crédite le wallet du titulaire (une fois par paiement), puis le service
   propriétaire de l'objet rejoue son débit avec **la même clé**. Le paiement ne règle jamais l'objet
   directement : il n'existe plus de page de paiement par mission ou par facture, donc plus de double
   paiement possible. Un crédit arrivé alors que l'objet est déjà payé reste dans le wallet. Le
   virement d'une entreprise et les espèces au guichet sont des crédits saisis par la finance et validés
   par une deuxième personne (R-WL-02, ADR-048 décision 9), suivis du même débit.
3. **Frais de visite** : montant du catalogue (catégorie de lieu, majoration de commune, R-FV-01), débité
   à l'envoi de la demande du wallet du contexte actif (personnel ou organisation) ; solde insuffisant :
   demande `awaiting_visit_fee`, annulée après 72 h (R-FV-02, R-FV-03). Reçu émis par `billing` dès le
   paiement, entreprise comprise (R-FV-04). Remboursement en entier au wallet dans les cas de R-FV-06.
   Déduction (R-FV-05, réglage activé par défaut) : particulier, sur le premier débit de séance puis les
   suivants s'ils dépassent le prix d'une séance (R-PP-02) ; entreprise, ligne négative sur sa première
   facture mensuelle.
4. **Particulier : paiement après chaque séance** (partie 11.1). À la clôture (ou à la séance manquée
   par absence du client, 50 % du prix, R-EX-02), le prix devient dû et `cleaning` débite le wallet.
   Solde insuffisant : séance `due`, lien de paiement du montant exact, 24 h de grâce (R-PP-03) ; puis
   `overdue` : la séance suivante ne démarre pas et le programme est suspendu (cause cumulée, ADR-030,
   R-PP-04). Un crédit au wallet relance les débits en attente, la plus ancienne séance d'abord ; le
   paiement du retard lève la cause. Une facture par séance, émise par `billing` au paiement (R-PP-06).
   Option « garantie de solde » (R-PP-05), désactivée par défaut.
5. **Entreprise : facture mensuelle des séances réalisées** (partie 11.2). `billing` écoute
   `cleaning.session.completed` et `cleaning.session.missed` et garde chaque ligne facturable ; le 1er
   du mois (heure du Bénin), il émet **une facture par organisation** pour le mois écoulé, lignes
   groupées par programme et par lieu, avec la date de chaque séance. **Pas de prorata** : une
   suspension n'a rien à déduire, une séance non faite n'est pas facturée. En-tête figé à l'émission
   (ADR-028), échéance 10 jours, relances, avertissement à 1 impayée, suspension à 2 (R-PE-03 à 06).
   Règlement depuis le wallet de l'organisation (prélèvement automatique à l'échéance en option si le
   solde suffit), par Mobile Money ou par virement, selon la décision 2.
6. **Montant dans les événements de séance** : `cleaning.session.completed` et `cleaning.session.missed`
   portent le montant dû (entier XOF ; 50 % du prix pour une séance manquée), le payeur (particulier ou
   organisation), le programme, son numéro, le rang de la séance et sa date. `billing` construit la
   facture sans rappeler `cleaning`. Jamais d'adresse ni de position (partie 15.5).
7. **Avoirs au lieu du prorata** (R-PE-07, R-RC-03). Une facture émise ne change jamais. Une erreur se
   corrige par un **avoir** (`billing.IssueCreditNote`) ; une séance oubliée part sur la facture suivante.
   L'argent d'un avoir, d'un remboursement ou d'un geste commercial est un **crédit au wallet**, jamais
   une sortie d'argent automatique (R-WL-04). Un crédit de plus de 50 000 FCFA est validé par une
   deuxième personne. Arrêter un programme ne demande aucun remboursement : chaque séance est payée
   après coup (partie 12).
8. **Retrait du wallet vers Mobile Money** (R-WL-04, décision du 2026-11-18) : sur demande du client,
   traité par la finance et validé par une deuxième personne, par le mécanisme des reversements
   (ADR-041). Il remplace la règle « prépayé jamais reversé » d'ADR-046 (décision 1).
9. **Fiabilité.** Débits et crédits sont idempotents par objet ; un remboursement décidé par `cleaning`
   est publié dans l'outbox de la même transaction que la décision et appliqué par `wallet` (règle
   d'ADR-046, gardée) ; l'émission d'une facture est idempotente par objet (séance, frais de visite,
   organisation et mois) et rejouée tant qu'elle n'est pas confirmée. Le rapprochement des débits
   (ADR-048 décision 10) porte sur les objets v2.

## Alternatives écartées

- **Paiement Mobile Money direct de l'objet**, à côté du wallet : deux chemins vers la même dette, les
  protections d'ADR-032 et 048 à refaire ; c'est la source du double paiement de la v1.
- **Prépaiement du programme** (acompte, totalité) : le client avance l'argent de séances à venir, et un
  arrêt demande un remboursement au prorata (ADR-049) ; le paiement après séance n'en demande aucun.
- **Facture d'entreprise au prorata des jours** (ADR-025) : à corriger à chaque suspension ou
  annulation ; facturer les séances faites est exact et lisible.
- **Rappel de `cleaning` par `billing`** pour connaître le montant : couplage temporel ; le montant voyage
  dans l'événement.
- **Remboursement par appel direct de `cleaning` à `wallet.Credit`** (partie 15.4) : une panne entre la
  décision et l'appel perdrait le remboursement ; l'événement dans la même transaction ne se perd pas.

## Conséquences

- `wallet` : objets débités v2, crédit rattaché à un objet, retrait vers Mobile Money (double
  validation), rapprochement des débits sur les objets v2.
- `payment` : la recharge rattachée à un objet remplace les objets payés `cleaning_mission` et
  `billing_invoice` (ADR-031) ; `GetMissionAmountDue` et les pages par objet du Nettoyage disparaissent.
- `billing` : lignes facturables reçues par événement, facture par séance (particulier), reçu des frais
  de visite, facture mensuelle par organisation, avoirs ; les contrats de facturation et le prorata
  (ADR-025, ADR-049 décisions 8 et 9) disparaissent, par migration en avant (ADR-054).
- `cleaning` : statut de paiement de chaque séance (`not_due`, `due`, `overdue`, `paid`, `waived`),
  solde des frais de visite à déduire, causes de suspension « séances en retard » et « factures
  impayées ».
- Ruptures de contrat de `billing`, `payment` et `wallet` déclarées une par une (ADR-054, décision 7).
- ADR-025, 028, 030, 031, 032, 046, 048 et 049 sont remplacés en partie (ligne « Remplacé » sous leur
  statut).

## À valider

- Montant payé par Mobile Money quand le solde manque : le montant **entier** de l'objet (retenu ici,
  indépendant du solde au moment du paiement) ou seulement ce qui manque.
- Noms des événements : la partie 15.5 cite `payment.payment.succeeded` et `wallet.account.credited` ;
  le dépôt publie `payment.intent.succeeded` et `wallet.prepaid.credited`. Proposition : garder les noms
  publiés (contrats d'autres services).
- Émission des factures : appel gRPC `billing.IssueInvoice` (partie 15.4) rejoué tant qu'il n'est pas
  confirmé, ou événement `cleaning.session.paid` écouté par `billing`.
- Avoir d'une entreprise : crédité à son wallet (retenu) ou imputé sur la facture suivante.
- Annulation tardive d'une séance (50 %, partie 12) : aucun événement de la partie 15.5 ne porte ce
  montant ; proposition : `cleaning.session.cancelled` avec `amountDue` (0 ou 50 %).
- Libellé du lieu dans l'événement de séance pour grouper la facture « par lieu » (nom donné par le
  client, pas une adresse) : à accepter dans l'événement, ou numéro de programme seul.
- Déduction des frais de visite plus grande que la première facture d'une entreprise : reportée sur les
  suivantes, comme pour le particulier.
- Régime de TVA (R-PE-02) : non appliqué, à confirmer par le comptable.
