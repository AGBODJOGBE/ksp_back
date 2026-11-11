# ADR-053 — Compléments du Nettoyage

**Statut** : Proposé (phase 1 des compléments demandés le 2026-11-10 après l'inventaire du module)

## Contexte

L'inventaire du Nettoyage sur `main` (2026-11-10) a relevé des manques d'exploitation : photos des
passages prévues dans le modèle (`beforePhotoFileIds`, `afterPhotoFileIds`) sans route ; devis
« expirés » seulement à l'affichage (aucun enregistrement, aucun message) ; aucun moyen de reporter un
seul passage ; agents et équipes impossibles à retirer ; indisponibilité déclarée sans voir les passages
déjà planifiés ; visites techniques sans contrôle d'agenda et laissées « planifiées » quand leur demande
est close. Les règles d'argent (annulation, acompte, remboursements) relèvent d'un autre lot et ne sont
pas touchées ici.

## Décision

1. **Photos des passages** (service `file`, ADR-038). Le compte connecté (agent du passage ou
   supervision) envoie la photo à file (`POST /api/v1/file/uploads`, finalité
   `cleaning_intervention_photo`, puis confirmation), puis la rattache au passage par cleaning, qui
   appelle `FileInternalService.AttachFile` (objet `cleaning_intervention`, au nom de ce compte : file
   refuse le fichier d'un autre, `FILE_OWNER_MISMATCH`). cleaning ne garde que les références, par type
   (`before`, `after`), et seulement pour un passage **non clos** (ni terminé, ni annulé :
   `CLEANING_INTERVENTION_CLOSED`). Nombre maximal **par type et par passage** réglable
   (`maxInterventionPhotos`, 10 par défaut, `CLEANING_PHOTO_LIMIT_REACHED`). Retrait : suppression chez
   file d'abord, puis la référence (idempotent). Lecture avec des adresses de courte durée
   (`ListFiles`) : le client de la mission, l'agent du passage, la supervision. Les erreurs de file sont
   transmises telles quelles.
2. **Échéances des demandes** : une tâche planifiée de cleaning (toutes les 10 minutes,
   `CLEANING_REQUEST_DEADLINES_INTERVAL_MS`, 0 = désactivée), idempotente et sûre sur plusieurs
   instances :
   - un devis envoyé dont la validité est dépassée devient **« expiré »** (contrôle de version) et
     `cleaning.quote.expired` est publié dans la même transaction ;
   - **rappel** au client N jours avant l'expiration (`quoteExpiryReminderDays`, 2 par défaut, 0 à 30,
     **0 = aucun rappel**), `cleaning.quote.expiry_reminded` : une seule fois par devis, grâce à un
     marquage conditionnel (`expiry_reminded_quote_id`) écrit avec l'événement ; un devis révisé a son
     propre rappel ;
   - un message par **lot** : même client et même groupe de demandes (ou demande seule), 10 devis au plus.
3. **Gestion d'un passage seul** (supervision) :
   - **reporter** un passage planifié : nouveau début dans le futur, **mêmes contrôles que la
     planification** (agents actifs, conflits d'agenda sous verrou des agents, mission suspendue
     refusée), agents gardés par défaut ou changés (agents et/ou équipe), motif obligatoire gardé sur
     le passage (`changeReason`), `cleaning.intervention.rescheduled` (client, agents du passage, agents
     libérés) ;
   - **annuler un passage pour le replanifier** : le passage est annulé avec la cause `unscheduled`, la
     mission retrouve un passage à planifier ; le nombre de passages prévus ne change pas, **aucun effet
     sur l'argent** ; `cleaning.intervention.unscheduled` (client, agents libérés). La suppression
     définitive d'un passage avec remboursement est reportée en phase 2. **Contrat REST additif** : la
     gateway garde les valeurs déjà publiées de `cancellationCause` (`suspension`, `manual`) ; un tel
     passage y apparaît en `manual` avec le champ facultatif `toReschedule: true` (présent seulement dans
     ce cas). Le proto et le domaine gardent la cause `unscheduled` (ajout admis par buf ; une nouvelle
     valeur d'énumération dans une réponse REST serait une rupture pour les fronts, refusée par oasdiff).
4. **Agents et équipes** (cleaning_admin, super_admin) :
   - **désactiver un agent** : refusé tant qu'il a des passages actifs ou des visites planifiées à venir,
     avec leur liste (`CLEANING_AGENT_HAS_ASSIGNMENTS`, 409). Choix retenu : **refus, sans réaffectation
     automatique** (le plus simple et le plus sûr : la supervision reporte ou réaffecte en connaissance
     de cause, avec les routes existantes). Réactivation possible ; aucune suppression ;
   - **supprimer une indisponibilité** (`CLEANING_UNAVAILABILITY_NOT_FOUND` si elle n'existe pas) ;
   - **désactiver une équipe** (et la réactiver) : gardée, plus proposée à la planification
     (`CLEANING_TEAM_INACTIVE`) ; les membres désactivés d'une équipe active sont ignorés à la
     planification ; un agent nommé explicitement doit être actif ;
   - **déclarer une indisponibilité** qui chevauche des passages ou des visites déjà planifiés : refus
     par défaut avec la liste (`CLEANING_UNAVAILABILITY_CONFLICT`, 409) ; avec `force: true`,
     enregistrée, la liste renvoyée en avertissement (`overlappingAssignments`).
5. **Visites techniques** :
   - **agenda de l'agent** : même règle que les passages (`conflictingAgents`) ; une visite occupe la
     durée réglée d'une visite (`visitDurationMinutes`, 60 minutes par défaut, 15 à 480). Les passages
     voient aussi les visites, et inversement ; ce qui est prévu au même lieu (même groupe, ADR-035)
     n'est pas un conflit ; une visite replanifiée ne se compte pas elle-même. Le contrôle d'une visite
     est fait avant l'enregistrement, **sans verrou** (volume du back-office faible) ;
   - **visite annulée avec sa demande** : quand une demande (ou toutes celles d'une visite commune) est
     refusée, annulée, déclinée ou expirée, la tâche des échéances passe la visite « annulée » et publie
     `cleaning.visit.cancelled` (message à l'agent) pour une visite encore à venir. En attendant la
     tâche, la visite d'une demande close **s'affiche** déjà annulée et ne compte plus dans l'agenda.
     Une visite commune reste planifiée tant qu'une de ses demandes est ouverte ; les demandes closes en
     sont retirées sans message.

### Réglages ajoutés (back-office, `PUT /api/v1/admin/cleaning/catalog/settings`)

| Réglage                   | Défaut | Bornes   | À l'écriture                                  |
| ------------------------- | ------ | -------- | --------------------------------------------- |
| `quoteExpiryReminderDays` | 2      | 0 à 30   | absent : inchangé ; **0 désactive le rappel** |
| `maxInterventionPhotos`   | 10     | 1 à 50   | absent (0 en gRPC) : inchangé                 |
| `visitDurationMinutes`    | 60     | 15 à 480 | absent (0 en gRPC) : inchangé                 |

Configuration du service : `CLEANING_REQUEST_DEADLINES_INTERVAL_MS` (600000), `FILE_GRPC_URL`
(`localhost:50056`).

### Routes ajoutées (gateway)

| Route                                                                         | Accès                                   |
| ----------------------------------------------------------------------------- | --------------------------------------- |
| `GET /api/v1/cleaning/interventions/{id}/photos`                              | client de la mission                    |
| `GET`, `POST /api/v1/admin/cleaning/interventions/{id}/photos`                | supervision, agent du passage           |
| `DELETE /api/v1/admin/cleaning/interventions/{id}/photos/{file}`              | supervision, agent du passage           |
| `POST /api/v1/admin/cleaning/interventions/{id}/reschedule`                   | `cleaning_supervisor`, `cleaning_admin` |
| `POST /api/v1/admin/cleaning/interventions/{id}/unschedule`                   | `cleaning_supervisor`, `cleaning_admin` |
| `POST /api/v1/admin/cleaning/agents/{id}/deactivate`, `…/reactivate`          | `cleaning_admin`                        |
| `DELETE /api/v1/admin/cleaning/agents/{id}/unavailabilities/{unavailability}` | `cleaning_admin`                        |
| `POST /api/v1/admin/cleaning/teams/{id}/deactivate`, `…/reactivate`           | `cleaning_admin`                        |

`super_admin` a partout la portée de `cleaning_admin` ; double authentification du back-office exigée.
`POST /api/v1/admin/cleaning/agents/{id}/unavailabilities` accepte `force`.

### Événements ajoutés

`cleaning.quote.expired`, `cleaning.quote.expiry_reminded`, `cleaning.intervention.rescheduled`,
`cleaning.intervention.unscheduled`, `cleaning.visit.cancelled` (schémas dans
`contracts/events/cleaning/`). Aucun motif, adresse ni commentaire dans les événements ; notification
les écoute (modèles WhatsApp à faire approuver, liste dans son README).

## Alternatives écartées

- **Expiration calculée seulement à l'affichage** (état d'avant) : aucun événement, donc aucun message
  ni trace ; les statistiques et la libération des visites en dépendent.
- **Réaffectation automatique des passages d'un agent désactivé** : choix des remplaçants opaque, risque
  de surcharger un agent ; la liste rendue permet à la supervision de décider.
- **Annulation des visites dans chaque cas d'usage de clôture** (refus, annulation par le client, groupe,
  expiration) : plusieurs chemins à tenir à jour ; la tâche des échéances couvre tous les cas, l'affichage
  et l'agenda ignorant déjà ces visites.
- **Photos envoyées à travers cleaning** : contraire à l'ADR-038 (le contenu ne transite jamais par les
  services).

## Conséquences

- Migration `0017_cleaning_complements` (colonnes de réglages, rappel du devis, motif du passage, équipe
  active, index des visites) : après `0012_mission_credit` (ADR-049) et les migrations des passages par
  dates (`0015`, `0016`), dans l'ordre de fusion.
- cleaning appelle `file` (jeton de service) : déployer file avant d'ouvrir les routes de photos.
- Un passage annulé pour être replanifié garde son historique (date, agents, motif).

## À valider

- Délai de la tâche des échéances (10 minutes) et heure des rappels (aucune fenêtre horaire : un rappel
  peut partir la nuit).
- Durée par défaut d'une visite (60 minutes) et contrôle sans verrou des visites.
- Visite passée d'une demande close : annulée sans message (aucun intérêt à prévenir l'agent).
- Photos d'un passage terminé : gelées (aucun ajout ni retrait après la clôture) — à confirmer.
- Lecture des photos par les membres d'une organisation : aujourd'hui le seul client de la mission
  (phase 2, visibilité par l'organisation).

## Phase 2 (préparée, non faite)

- **Frais d'annulation tardive, remboursement espèces / Mobile Money** : la cause `unscheduled`
  distingue déjà l'annulation pour replanifier (sans argent) des annulations à rembourser ;
  `changeReason` porte le motif.
- **Visibilité des demandes et missions par les membres de l'organisation** : le contrôle d'accès des
  photos du client est isolé dans `ListMyInterventionPhotosUseCase`, à aligner sur la règle commune.
- **`identity.user.deleted`** : les photos des passages restent chez file (« gardé, détaché », ADR-038) ;
  rien à ajouter dans cleaning.
