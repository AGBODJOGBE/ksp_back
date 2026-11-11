# ADR-049 — Règles du Nettoyage et de la facturation

**Statut** : Proposé (décisions du responsable et corrections de la revue de code, 2026-11-10)

## Contexte

La revue de code du Nettoyage (`cleaning`) et de la facturation (`billing`) a relevé des règles absentes
ou fausses : contexte utilisateur cru de n'importe quel service, dossiers d'une organisation accessibles
hors de son contexte, devis à 0 FCFA, paiement « avant » sans effet, mission récurrente qu'on ne peut pas
arrêter proprement, prestation ponctuelle d'entreprise facturée sur deux mois, montant de facture calculé
hors verrou, dates en UTC au lieu de l'heure du Bénin. Le lot « argent » (ADR-048, services `payment` et
`wallet`) a posé les contrats que ce lot implémente côté `cleaning` et `billing` (commit a8a221d) :
`WalletDebitCheckService` et l'événement `cleaning.mission.credited`.

## Décision

1. **Méthodes réservées à la gateway.** Le contexte utilisateur (métadonnées) n'est cru que de la
   gateway : toute méthode du client, du back-office ou du catalogue public de `cleaning` et `billing`
   appelée par un autre service est refusée (`CLEANING_CALLER_FORBIDDEN`, `BILLING_CALLER_FORBIDDEN`).
   Le contrôle est fait là où l'utilisateur est lu (`currentCustomer`, `requireStaff`) et sur les
   méthodes publiques du catalogue. Les méthodes internes gardent leurs appelants : `identity`
   (`HasPendingObligations`), `payment` (`GetMissionAmountDue`, `GetInvoiceAmountDue`), `wallet`
   (`GetWalletDebitStatus`). Sans vérificateur de jeton (développement local), l'appelant n'est pas
   connu et l'appel passe, comme partout.
2. **Rapprochement des débits du portefeuille (ADR-048).** `WalletDebitCheckService.GetWalletDebitStatus`,
   réservé à `wallet` : `true` si un paiement par portefeuille de la mission (ou de la facture) cite ce
   débit, remboursé ou non ; `false` sinon, mission ou facture inconnue comprise.
3. **Dossiers d'une organisation.** Une demande, un groupe de demandes ou une mission d'organisation
   n'est visible que dans le contexte actif de cette organisation (sinon 404, sans révéler le dossier).
   Agir en son nom (demander un devis, accepter, refuser, annuler, payer) exige `org_admin` ou
   `org_member` ; `org_viewer` reste en lecture (`AUTH_FORBIDDEN`). « Mes demandes » et « Mes missions »
   suivent le contexte actif : dossiers personnels, ou ceux de l'organisation active. Le paiement d'une
   facture le faisait déjà (`currentPayer`, ADR-046).
4. **Devis à 0 FCFA refusé** : le sous-total des lignes doit être strictement positif
   (`CLEANING_VALIDATION_FAILED`, champ `lines`).
5. **Annulation sans frais sans passage planifié** : le délai d'annulation se compte depuis le premier
   passage planifié ; sans passage planifié, rien n'est engagé et l'annulation est gratuite, même si le
   créneau choisi au devis est passé.
6. **Paiement « avant »** : le passage reste planifiable, mais il ne démarre pas tant que le montant dû
   avant (l'acompte, ou la totalité pour un plan « totalité ») n'est pas payé
   (`CLEANING_UPFRONT_PAYMENT_DUE`, `details.amountDue`). Une mission d'entreprise, réglée par facture,
   n'est pas concernée. Chaque passage planifié annonce ce montant au client : champ facultatif
   `amountDueBeforeStart` de `cleaning.mission.scheduled` (ajout compatible).
7. **Arrêt de la suite d'une mission récurrente (décision du responsable)** : après des passages faits,
   le client annule la suite comme une mission (même délai sans frais, compté depuis le prochain passage
   planifié). Les passages faits restent dus : le montant de la mission devient celui des passages faits
   (total × faits / prévus, arrondi à l'entier XOF) ; les passages suivants sont annulés. Ce qui a été
   payé au-delà, **quel que soit le moyen de paiement**, est crédité dans le portefeuille prépayé du
   client : crédit enregistré sur la mission (`credit_id`, `credited_amount`, `credited_at`, migration
   `0012_mission_credit`) et `cleaning.mission.credited` publié dans la même transaction ; `wallet`
   crédite une seule fois par `creditId`. Le crédit ne compte plus dans le montant payé. Payé moins que
   les passages faits : rien à créditer, le reste dû demeure. Sans passage fait, la règle d'ADR-046
   s'applique (remboursement des seuls paiements par portefeuille).
8. **Entreprise** : l'annulation de la suite termine le contrat de facturation au jour de l'annulation
   (`cleaning.request.cancelled`, inchangé) ; le mois en cours est facturé au prorata jusqu'à ce jour.
9. **Prestation ponctuelle d'entreprise** : facturée en une fois, en entier, sur la facture du mois
   civil (Bénin) de son passage, émise à la fin de ce mois ; rien si elle est annulée ce jour-là ou
   avant. Contrat marqué `one_off` (migration `0007_contract_one_off`).
10. **Paiement en ligne sur une mission annulée** : enregistré (l'argent est reçu), mais tout le
    montant est un trop-perçu, tracé dans le journal d'audit et signalé par une alerte, comme pour une
    facture.
11. **Facture** : montant recalculé depuis le contrat relu sous son verrou (un événement enregistré
    entre la lecture et l'émission compte) ; numéro dans l'année de la période facturée, au Bénin (la
    facture de décembre émise en janvier garde l'année de décembre) ; mois ajoutés au calendrier du
    Bénin (`Africa/Porto-Novo`, UTC+1 sans heure d'été), plus en jours UTC.

## Compatibilité

- Contrats : ajouts seulement. `cleaning.mission.scheduled` gagne un champ facultatif ; le code
  `CLEANING_UPFRONT_PAYMENT_DUE` est documenté (en-tête de `cleaning.proto`, OpenAPI).
  `WalletDebitCheckService` et `cleaning.mission.credited` sont ceux du commit a8a221d, sans changement.
- Migrations : ajouts de colonnes seulement. Les contrats de facturation existants restent récurrents
  (`one_off = false`) : leurs factures déjà émises ne changent pas.
- Comportements changés pour les fronts : une organisation doit être le contexte actif pour voir ou
  traiter ses dossiers ; un membre `org_viewer` ne peut plus agir ; un passage « avant » non payé ne
  démarre plus. Les numéros de facture émis en janvier pour décembre gardent l'année de décembre.

## Ordre de déploiement

1. `cleaning` et `billing` (migrations, puis service) : `GetWalletDebitStatus` répond avant que `wallet`
   ne l'appelle.
2. `wallet` (ADR-048) : abonnement à `cleaning.mission.credited` et rapprochement des débits. Un
   crédit publié avant le déploiement de `wallet` attend dans sa file.
3. Gateway et fronts : message d'erreur du démarrage refusé, sélection du contexte d'organisation.

## Points à valider

- Arrêt par la supervision d'une mission récurrente avec passages faits : la règle du crédit au prorata
  n'est appliquée qu'à l'arrêt par le client ; la supervision garde la règle d'ADR-046.
- Reste dû des passages faits après l'arrêt : aucun moyen de paiement n'accepte une mission annulée
  (`payment`, portefeuille, saisie du back-office) ; à encaisser hors plateforme ou à ouvrir.
- Message au client pour le paiement « avant » : le champ est publié, le modèle de message de
  `notification` reste à écrire (et à faire approuver pour WhatsApp).
- Prestation ponctuelle : facturée au mois du créneau choisi à l'acceptation, même si le passage est
  planifié à une autre date.
