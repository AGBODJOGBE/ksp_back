# ADR-062 — Tarification du recouvrement : règles versionnées dans `recovery`

**Statut** : Accepté (2026-11-20). Décision validée par le responsable le 20/11/2026.

## Contexte

La partie 13 du cahier des charges veut des prix réglés au back-office, sans code : frais de dossier,
commission de recouvrement, forfait d'étude, mais aussi commissions de gestion locative et de mise en
relation, frais de visite et abonnements. Chaque prix est une règle versionnée, figée dans le mandat
ou l'abonnement à sa signature ; les plafonds légaux (art. 29 de la loi n° 2018-12) sont imposés par
le code. La partie 16.2 place `PricingRule` dans un « commun » sans dire quel service la porte.

Règle d'or n° 2 : un service = un domaine métier ; `@ksp/platform` ne contient aucun code métier.

## Décision

1. **Les règles du recouvrement vivent dans `recovery`**, pour ses seuls objets : `case_fee` (frais
   de dossier), `recovery_commission` (commission sur les sommes recouvrées), `study_fee` (forfait
   d'étude retenu sur un dossier irrecevable). `rental` aura ses propres règles et ses plafonds légaux
   (gestion ≤ 10 % du loyer mensuel, mise en relation ≤ 50 % d'un mois de loyer, frais de visite) ;
   les **abonnements** relèvent de `billing`. Pas de service commun de tarification.
2. **Modes** : `fixed` (montant), `percentage` (taux), `tiered` (par tranches : pour la commission,
   taux par tranche du cumul encaissé, par exemple 15 % jusqu'à 1 000 000 FCFA puis 10 % au-delà ;
   pour les frais de dossier, montant fixe par tranche du montant dû), `by_stage` (taux par étape
   atteinte : `amicable` — notification, échéancier, relance —, `formal_notice`, `litigation` —
   huissier et judiciaire). **Bornes** facultatives : voir la décision 3.
3. **Calcul en entiers** : montants en francs, taux en points de base (1 000 = 10 %) ; calcul exact
   et **un seul arrondi, à l'entier inférieur**, à la fin (KSP ne prélève jamais plus que la règle,
   comme ADR-042), puis bornes.
   - **Commission par tranches : calcul progressif sur le cumul encaissé du dossier.** Chaque part du
     cumul est prise au taux de sa tranche ; la commission d'un encaissement est la commission du
     cumul après lui, moins celle du cumul avant lui. Elle ne dépend ni du découpage des paiements ni
     de leur ordre, et n'est jamais négative (15 % jusqu'à 1 000 000 FCFA puis 10 % : 150 000 FCFA à
     1 000 000, 160 000 à 1 100 000).
   - **Frais de dossier par tranches** : un montant fixe, celui de la tranche où tombe le montant dû.
   - **Par étape** : la commission de chaque encaissement prend le taux de l'étape atteinte à cet
     instant.
   - **Bornes** : le **maximum** s'applique à chaque encaissement ; le **minimum** s'applique **au
     cumul du dossier** (commission minimale par dossier, complétée sur les encaissements suivants,
     jamais exigée de chaque versement d'un échéancier). Pour les frais de dossier et le forfait
     d'étude, montants uniques, les bornes s'appliquent au montant calculé.
4. **Cible** : offre (`b2b`, `b2c`, `rent` ou `any`), commune (clé de `geo`, facultative), créancier
   précis (tarif négocié, facultatif). **Une seule règle publiée par objet et par cible sur une même
   période** (`RECOVERY_PRICING_RULE_CONFLICT`). Résolution : client précis, puis offre et commune,
   puis offre, puis `any`. Une règle négociée pour un client prime sur la règle générale (R-TA-04).
5. **Cycle de vie** : `draft` → `published` → `archived` ; une règle négociée passe par
   `pending_approval` et n'est publiée qu'après la **validation d'une seconde personne**
   (`RECOVERY_APPROVAL_BY_REQUESTER` sinon). Une règle publiée ne change plus : toute modification crée
   une nouvelle version (`previousVersionId`), dont la publication archive la précédente. Publication
   refusée pour une règle incomplète ou incohérente (`RECOVERY_PRICING_RULE_INVALID` : tranches
   croissantes et contiguës, dernière tranche sans limite, taux de 0 à 10 000, minimum ≤ maximum,
   trois groupes d'étapes pour `by_stage`).
6. **Version figée dans le mandat** (R-CO-02) : `EstimateCaseFees` montre les frais et la commission
   avant l'envoi (R-TA-03) ; la préparation du mandat fige la règle des frais et celle de la commission
   (identifiant et version) sur le dossier ; un changement de tarif ne touche pas les dossiers en cours.
7. **Simulateur** du back-office (R-TA-01) : effet d'une règle, brouillon compris, sur un exemple
   (montant de base, étape, cible), avec le détail ligne par ligne et la borne appliquée.
8. **Droits** : création et publication par `recovery_admin` et `super_admin`, lecture et simulation
   aussi par `finance_officer` ; double authentification de la session (12 heures) pour créer ou
   modifier un brouillon, de moins de 10 minutes pour publier, valider ou archiver ; chaque opération
   écrite au journal d'audit.

## Alternatives écartées

- **Service commun `pricing`** : un service de plus, appelé à chaque calcul, pour des objets qui
  appartiennent chacun à un métier ; les plafonds légaux de la location n'ont rien à faire dans le
  recouvrement.
- **Moteur de règles partagé dans `@ksp/platform`** : du code métier dans le kit technique.
- **Formule libre saisie au back-office** : dangereuse et difficile à tester (déjà écartée par ADR-033).
- **Arrondi au plus proche** : prélèverait parfois un franc de plus que la règle.
- **Commission par tranches sur le montant entier** (le taux de la tranche atteinte appliqué à tout
  le cumul) : passer un seuil changerait le taux de ce qui a déjà été encaissé, jusqu'à une
  commission négative sur l'encaissement suivant.
- **Minimum de commission à chaque encaissement** : un échéancier de petits versements paierait le
  minimum à chaque échéance, bien au-delà du taux convenu.

## Conséquences

- Domaine pur de la tarification dans `recovery` (couverture d'au moins 90 %), critère du lot A : une
  commission par étape publiée et son effet visible sur un exemple.
- Le critère « règle de gestion locative à 11 % refusée » du lot A relève de `rental`.
- `rental` reprendra la même forme de règle (contrat à part) pour que le back-office garde un écran
  semblable.

## À valider

- Montants de départ de la grille (partie 13.2), à fixer par KSP.
