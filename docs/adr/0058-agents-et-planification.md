# ADR-058 — Agents et planification du Nettoyage v2 : inscription, contrôles d'affectation, planification automatique

**Statut** : Proposé (2026-11-19)

## Contexte

En v1, l'admin rattache des agents existants, la supervision planifie chaque passage à la main
(ADR-052 : planification en lot ; ADR-053 : report, désactivation refusée sans réaffectation,
indisponibilité forcée qui garde les passages, visites contrôlées sans verrou). Le cahier des charges
v2 (partie 9) fait des agents le cœur du système : inscription par l'agent, compétences validées,
disponibilités, mêmes contrôles pour l'affectation manuelle et automatique, planification automatique
à horizon glissant.

## Décision

1. **Inscription et statuts** (9.1, R-AG-01 à 04). L'agent crée son compte depuis l'application agent
   (téléphone et code) et dépose sa candidature : identité, photo, pièce d'identité (recto, verso),
   commune de résidence, zones souhaitées, compétences déclarées, disponibilités, personne à prévenir,
   statut `salaried` ou `independent`. Statuts : `applicant` → `under_review` → `active` ⇄ `suspended`
   → `deactivated`, ou `under_review` → `rejected` (motif). L'admin valide les compétences une par une ;
   la validation donne le rôle `cleaning_agent` (ADR-057). Pièce d'identité stockée par `file`
   (finalité dédiée), chiffrée, lisible de l'admin Nettoyage seulement. Un agent n'est jamais supprimé.
2. **Compétences** : liste gérée au back-office ; chaque type de nettoyage en exige une (R-CA-09). Une
   compétence déclarée mais non validée ne compte pas.
3. **Disponibilités** (9.2) : modèle hebdomadaire (plages par jour), exceptions (indisponibilité ou
   disponibilité exceptionnelle, date ou période), charge maximale par jour et par semaine (8 h et 48 h
   par défaut, par agent), fuseau `Africa/Porto-Novo`. Une indisponibilité qui chevauche une affectation
   est refusée avec la liste ; forcée par le superviseur, elle **désaffecte** l'agent et relance la
   planification des séances touchées (R-DS-04). L'agent ne retire pas seul une plage déjà occupée.
4. **Contrôles d'une affectation** (9.4) : une fonction pure du domaine rend, pour chaque agent, les
   contrôles échoués et s'ils sont contournables. Non contournables : actif, compétences couvertes par
   l'équipe réunie, aucun conflit. Contournables avec motif : zone, disponibilité, charge, taille
   d'équipe (moins d'agents : alerte). **Conflit** : aucune autre visite ou séance de l'agent sur la
   période, temps de trajet compris depuis l'affectation précédente du même jour **et vers la
   suivante** (OSRM par `geo`, réglage de 30 min si indisponible, ADR-059). Mêmes contrôles pour les
   visites (60 min par défaut, R-VI-02) et les séances.
5. **Verrou d'agenda** : contrôles et écriture dans une transaction, sous verrou consultatif
   transactionnel de chaque agent concerné, pris dans l'ordre de leurs identifiants (pas d'interblocage).
   Deux superviseurs, ou la planification automatique et un superviseur, ne peuvent pas affecter le même
   agent au même moment. Les visites passent sous le même verrou (fin du contrôle sans verrou d'ADR-053).
6. **Planification manuelle** (9.5) : affecter un ou plusieurs agents ou une équipe (membres actifs et
   disponibles, les autres signalés), désaffecter, remplacer, changer le chef d'équipe, appliquer les
   mêmes agents à toutes les séances d'un programme ou à une sélection. Chaque action est tracée (qui,
   quand, motif). Toute séance de plus d'un agent a un chef d'équipe (R-EQ-03).
7. **Planification automatique** (R-PL-01 à 08) :
   - **déclencheurs** : acceptation d'un devis, tâche de nuit pour les séances « à affecter » de
     l'horizon (14 jours, réglable 1 à 60), désaffectation, indisponibilité ou désactivation d'un agent,
     reprise d'un programme, bouton du superviseur ;
   - **filtre** : seuls les agents qui passent **tous** les contrôles, contournables compris ;
     l'automatique ne force jamais ;
   - **score** pondéré (poids réglables, total 100 ; 40 / 25 / 20 / 15 par défaut) : continuité (agent
     déjà venu sur ce programme), proximité (zone et trajet depuis son affectation précédente ce
     jour-là), équilibre (moins d'heures planifiées dans la semaine), note moyenne. Chaque critère est
     ramené entre 0 et 1 ; égalité départagée par l'identifiant de l'agent (résultat reproductible) ;
   - **choix** : les meilleurs scores jusqu'à la taille d'équipe, en couvrant d'abord chaque compétence
     manquante par le meilleur candidat qui l'a ; chef d'équipe : le mieux noté parmi ceux qui ont
     l'aptitude ;
   - **trois modes par zone** (R-PL-05) : `manual`, `proposal` (défaut : le système propose, le
     superviseur valide en un clic ou modifie), `automatic` (appliqué, superviseur prévenu en cas
     d'échec seulement) ;
   - **stabilité** : ne déplace jamais une affectation faite, ne remplit que les trous ;
   - **échec** : la séance reste « à affecter » (rouge au planning), alerte au superviseur, puis à
     l'admin si elle est toujours sans agent 48 h avant ;
   - **confirmation** : le salarié est confirmé d'office ; l'indépendant accepte ou refuse sous 12 h
     (réglable), sinon le système cherche un autre agent ;
   - la tâche de nuit est idempotente et ne tourne que sur une instance à la fois ; chaque séance est
     traitée dans sa propre transaction, la plus urgente d'abord.
8. **Désactivation d'un agent** (R-AG-03) : refusée tant qu'il a des affectations à venir, **sauf** si
   l'admin demande leur réaffectation automatique ; les séances libérées passent par la décision 7.

## Alternatives écartées

- **Planification seulement manuelle** (v1) : ne tient pas avec des agents nombreux et des programmes
  récurrents.
- **Optimisation globale** (solveur sur toutes les séances de l'horizon) : meilleure répartition
  théorique, mais résultat difficile à expliquer, qui peut déplacer des affectations faites (contraire à
  R-PL-07) ; le choix séance par séance, avec un score lisible, suffit au critère du lot G (50 séances,
  10 agents).
- **Contrôle sans verrou, avec nouvelle tentative** : deux affectations simultanées passeraient toutes
  les deux les contrôles.
- **Contrainte d'exclusion de PostgreSQL sur les créneaux** : ne sait pas tenir compte d'un temps de
  trajet qui dépend des deux lieux.

## Conséquences

- `cleaning` : agents, compétences, disponibilités, équipes, affectations (`source` `manual` ou `auto`,
  confirmation, motif), tâche de planification, réglages de la partie 16.1 (mode par zone, horizon,
  poids, délai d'acceptation, charges).
- Appels à `geo.DistanceMatrix` pendant les contrôles ; trajets en voiture seulement (ADR-059).
- ADR-052 (décision 8, planification en lot) et ADR-053 (décisions 3 à 5) sont remplacés en partie.

## À valider

- Contrôle du trajet aussi vers l'affectation **suivante** (proposé, par prudence) ; aucune contrainte
  de trajet pour la première affectation du jour.
- Mesure de chaque critère du score entre 0 et 1 (proposition : continuité 1 ou 0 ; proximité 1 −
  trajet / 60 min, bornée ; équilibre 1 − heures planifiées / maximum de la semaine ; note / 5, et 0,5
  sans note).
- Aptitude « chef d'équipe » : drapeau de l'agent, absent du modèle de la partie 15.1.
- Une proposition (mode `proposal`) **réserve** l'agenda de l'agent jusqu'à sa validation, son refus ou
  la tâche suivante.
- Couverture des compétences avant le score (décision 7, choix).
