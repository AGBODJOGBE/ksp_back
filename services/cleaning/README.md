# Service cleaning

Nettoyage & assainissement (lot 2) : simulateur public, demandes de devis, devis, missions et passages, catalogue et grille tarifaire, agents et équipes. Contrat gRPC : `contracts/proto/ksp/cleaning/v1/cleaning.proto` (avec `ksp.common.v1.ObligationService`). Événements : `contracts/events/cleaning/`. Routes REST : contrat OpenAPI, étiquettes « Nettoyage ».

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/cleaning-service prisma:deploy   # crée les tables, les huit prestations (prix vides) et les types de lieu
pnpm --filter @ksp/cleaning-service build && node --env-file=.env dist/main.js
```

- gRPC : `localhost:50053` (adresse attendue par la gateway, `CLEANING_GRPC_URL`)
- Santé : `http://localhost:3103/health/live` et `/health/ready`
- Métriques : `http://localhost:3103/metrics`

### Données de démonstration (développement uniquement)

Les prestations de départ (formulaire, options, fréquences) sont créées par les migrations 0007 et 0008 (« Nettoyage de maison », « Nettoyage de vitres »), prix vides tant que l'équipe Nettoyage ne les a pas saisis au back-office : le simulateur répond alors `priced: false` (ADR-033). Pour essayer le simulateur en local, `prisma/demo/demo-data.sql` ajoute des **prix inventés** à cinq d'entre elles (la désinsectisation reste sans prix) ; le script refuse de s'exécuter sans l'accord explicite `ksp.demo=on` :

```bash
PGOPTIONS='-c ksp.demo=on' psql postgresql://cleaning:cleaning@localhost:5432/cleaning \
  -f services/cleaning/prisma/demo/demo-data.sql
```

Le même script ajoute, pour le parcours par lieu (ADR-034) : un type de lieu désactivé, un type qui référence une prestation désactivée, un groupe de trois demandes à des états différents (positions fictives dans Cotonou, repère, fournisseur `nominatim`), une demande dont la commune a été choisie à la main, une demande ancienne sans position et une mission avec position.

## Parcours par lieu et position GPS (ADR-034)

- **Types de lieu** (Maison, Villa, Appartement, Bureau, Chantier…) gérés au back-office
  (`/api/v1/admin/cleaning/place-types`) : libellé, icône, ordre, état, liste ordonnée des
  prestations proposées. `GET /api/v1/cleaning/catalog` rend, en un appel, les lieux actifs et
  leurs prestations actives avec leur formulaire.
- **Estimation** de 1 à 10 prestations d'un lieu (`POST /api/v1/cleaning/estimates`) : simulateur
  de l'ADR-033 pour chacune, total si toutes ont un prix. Commune facultative (coefficient neutre,
  `communeApplied: false`), comme pour `POST /api/v1/cleaning/simulations`.
- **Demandes groupées** (`POST /api/v1/cleaning/quote-request-groups`) : une demande par
  prestation, liées par un groupe, créées dans une transaction ; même position, repère, créneaux et
  commentaire ; un événement `cleaning.quote.requested` par demande, avec `groupId`, plus
  `cleaning.quote_group.requested` pour le groupe (ADR-035 point 14). Chaque demande suit ensuite
  son circuit habituel.
- **Commune retrouvée par géocodage inverse** depuis la position (`ReverseGeocoder`) : par le
  service interne `geo` quand `GEO_GRPC_URL` est renseignée (ADR-045 ; jeton de service
  d'audience `geo`, délai de l'appel `2 × GEOCODING_TIMEOUT_MS + 1 s`, geo indisponible = non
  trouvé). Sinon, repli sur l'appel direct : Nominatim auto-hébergé d'abord (`NOMINATIM_URL`),
  Google en secours (`GOOGLE_MAPS_API_KEY`), délai `GEOCODING_TIMEOUT_MS` (3 s) ; un fournisseur
  sans sa variable est désactivé. La commune trouvée
  remplace celle du client ; sans résultat, celle du client sert de repli
  (`CLEANING_LOCATION_UNRESOLVED` si elle manque). Rapprochement avec les zones par leur clé et
  leurs **noms alternatifs** (`aliases`).
- **Confidentialité** : coordonnées, repère et adresses jamais dans les journaux, les traces, le
  journal d'audit ni les événements ; appels vers les géocodeurs non tracés.

## Demandes groupées, visites des agents et position (ADR-035)

- **Plafond** : un groupe compte pour 1 dans `maxOpenRequests`, ouvert tant qu'une de ses demandes l'est.
- **Opérations de groupe** (une transaction chacune, rejouables par `Idempotency-Key`, table
  `request_group_operations`) : visite commune (`groupVisitId`, un seul `cleaning.visit.scheduled`,
  exclusion = détachement), compte rendu commun, refus (back-office) et annulation (client) du groupe,
  devis envoyés ensemble avec des créneaux communs, acceptation commune (une mission par devis),
  planification commune des missions. Les demandes qui ne s'y prêtent pas sont renvoyées dans `skipped`.
- **Messages regroupés** (point 14) : l'envoi groupé publie aussi `cleaning.quote_group.requested`, les
  devis envoyés ensemble `cleaning.quote_group.sent` (devis, total, validité), dans la même
  transaction ; leurs événements par demande portent `summarizedByGroup: true`. La visite commune
  liste ses demandes et leur prestation (`requests`). `cleaning.quote.requested` porte aussi
  `serviceName`.
- **Conflits d'agenda** : les passages des missions d'un même groupe (même lieu) ne se gênent pas.
- **Agents** : `GET /admin/cleaning/visits` (leurs visites seulement), compte rendu de leurs visites,
  correction de position tant que la visite est planifiée ; position, repère et adresse géocodée masqués
  pour eux une fois la visite ou la mission terminée ou annulée.
- **Zones** : nombre de demandes ouvertes et de missions actives ; désactivation avec `confirm: true` si
  ces nombres ne sont pas nuls.
- **Conservation de la position** : réglage `locationRetentionMonths` (12 mois) ; tâche
  `CLEANING_LOCATION_PURGE_INTERVAL_MS` (6 h, 0 : désactivée) qui efface coordonnées, précision, repère
  et adresse géocodée des dossiers clôturés, par lots ; effacement de tous les dossiers d'un client à
  `identity.user.deleted` (événement du contrat, pas encore publié par identity).

## Mesures constatées après la visite (ADR-037)

- **Mesures** : au compte rendu de la visite (par demande, ou par demande de la visite commune) ou ensuite
  (`PUT /admin/cleaning/quote-requests/{id}/measurements`), l'agent de la visite ou la supervision saisit
  les dimensions réelles dans les champs du formulaire du client, validées comme une simulation. Elles sont
  gardées à part (colonnes `measured_*`, migration `0010_visit_measurements`) avec leur calcul (grille en
  vigueur, commune de la demande), leur version de grille, leur date et leur auteur ; les réponses du client
  ne sont jamais remplacées. Chaque saisie est tracée (`request.measured`).
- **Verrou** : plus de saisie une fois un devis envoyé ou la demande close (`CLEANING_MEASUREMENTS_LOCKED`) ;
  une nouvelle visite après le devis rouvre la saisie.
- **Recalcul** : `POST /admin/cleaning/quote-requests/{id}/estimate`, même calcul que la simulation,
  rien n'est enregistré.
- **Devis** : sans lignes, prérempli depuis le calcul des mesures s'il existe (taille d'équipe comprise),
  sinon depuis celui de la demande.
- **Réponses lisibles** : `answerSummary` (client et back-office) et `measuredSummary` (back-office), libellés
  résolus avec la version de grille utilisée ; type de locaux et quantité pour une demande à l'ancien format.
  Les mesures ne sont jamais montrées dans l'espace client.
- **Liste des visites** : chaque demande de `GET /admin/cleaning/visits` porte les réponses du client
  (`answers`, `selectedOptions`, `frequency`, `pricingVersion`, `answerSummary`), son type de lieu et, s'il y
  en a, ses mesures (`measured*`), pour préremplir la saisie sur le terrain.
- **Montants** : un agent seul (sans rôle de supervision) ne voit jamais `calculation`, `estimate`, `quote` ni
  `measuredCalculation` (liste des visites, comptes rendus, mesures, correction de position : `requestForStaff`,
  `withAmounts`) ; seul le recalcul (`estimate`) lui renvoie le calcul, c'est son outil de saisie.

## Suppression d'un compte (ADR-036)

`ksp.common.v1.ObligationService`, appelé par identity seul (`CLEANING_CALLER_FORBIDDEN` sinon) à la
demande de suppression puis avant l'anonymisation : une mission non terminée
(`open_cleaning_mission`) ou une demande de devis ouverte — reçue, visite planifiée, devis envoyé
encore valide (`open_cleaning_request`) — bloque la suppression. `identity.user.deleted` efface les
positions des lieux du compte (ADR-035).

## Règles (cahier des charges, parties 4 et 9)

| Sujet      | Fonctionnement                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulateur | Formulaire paramétrable par prestation (ADR-033) : `max(minimum, (Σ nombre × prix par unité + suppléments + options × leurs coefficients) × coefficients des réponses × commune × fréquence)`, arrondi une fois au franc ; fourchette −10 % / +15 % arrondie à 500 FCFA ; entiers XOF. Rien n'est enregistré. |
| Grille     | Versionnée : chaque enregistrement crée une version datée avec son auteur ; un devis envoyé garde son prix.                                                                                                                                                                                                   |
| Réglages   | Validité des devis (15 j), délai minimum (48 h), annulation sans frais (24 h), 5 demandes ouvertes, acompte 30 %, seuils d'impayés : modifiables au back-office.                                                                                                                                              |
| Demande    | reçue → visite planifiée → devis envoyé → acceptée / refusée / expirée / annulée, ou refusée par KSP. Visite des lieux réalisée obligatoire avant tout devis.                                                                                                                                                 |
| Mission    | Un passage pour une prestation ponctuelle, plusieurs pour un contrat récurrent (passages par semaine ou par mois, sur N mois) ; chaque passage a ses agents, sa liste de contrôle et ses références de photos (service file).                                                                                 |
| Conflits   | Un agent ne peut être affecté à deux passages qui se chevauchent, ni pendant une indisponibilité (`CLEANING_TEAM_UNAVAILABLE`) ; agents verrouillés pendant la planification.                                                                                                                                 |
| Paiement   | Option choisie à l'acceptation (acompte ou totalité, avant ou après, espèces ou Mobile Money) ; état dû / acompte reçu / payé ; paiements manuels cochés par le superviseur ; paiement en ligne : port prévu (`payment`).                                                                                     |
| Droits     | Client : ses demandes et missions (404 sinon) ; agent : les missions où il est affecté ; superviseur et admin : rôle et double authentification revérifiés par le service.                                                                                                                                    |
| Traces     | Événements par l'outbox dans la transaction de l'état (identifiants seulement, jamais d'adresse ni de position) ; table `audit_log` pour les prix, devis, affectations, paiements, types de lieu et groupes de demandes.                                                                                      |

## Zones desservies et visite des lieux (décisions du 2026-10-23)

- **Zones** : le Nettoyage n'est ouvert que dans certaines communes, au départ Cotonou,
  Porto-Novo et Abomey-Calavi (migration `0003`). L'admin ajoute, réactive ou désactive une zone
  (`/api/v1/admin/cleaning/zones`) ; les fronts lisent les zones actives sur la route publique
  `GET /api/v1/cleaning/zones` (`CatalogService/ListServedZones`). Une zone est une commune identifiée par sa **clé normalisée**
  (minuscules, sans accents, tirets), la même que les coefficients de commune de la grille
  tarifaire : « Abomey Calavi » et « Abomey-Calavi » désignent la même zone, et le coefficient de
  cette clé s'y applique. Demande de devis hors zone : `CLEANING_ZONE_NOT_COVERED` ; le
  simulateur répond toujours, avec `covered: false`.
- **Visite des lieux obligatoire pour toute demande** (particulier ou entreprise) : le devis ne
  part qu'après une visite réalisée (`CLEANING_VISIT_REQUIRED`). Le réglage
  `visitThresholdSquareMeters` reste dans le contrat mais n'a plus d'effet.
- **Plan de paiement à l'acceptation** : obligatoire pour un particulier
  (`CLEANING_VALIDATION_FAILED`, `details.field = paymentPlan`) ; ignoré pour une entreprise, qui
  règle par sa facture mensuelle.
- **Paiement manuel** (`RecordPayment`) réservé aux particuliers : une mission d'entreprise se
  règle par sa facture (`CLEANING_PAYMENT_VIA_INVOICE`).

## Impayés, suspension et reprise (partie 10)

- **Réglages de l'admin** (`PUT /api/v1/admin/cleaning/catalog/settings`) : avertissement dès
  1 facture d'entreprise impayée, suspension à 2, suspension d'un particulier en récurrent à
  1 passage impayé, délai de grâce de 24 heures pour enregistrer le paiement d'un passage. Le
  délai de règlement des factures appartient à billing.
- **Entreprise** : cleaning consomme `billing.invoice.overdue` et `billing.invoice.paid` (inbox,
  table `contract_invoices` ; une facture payée ne redevient jamais impayée) et réévalue la
  mission. **Particulier** : tâche planifiée interne (`CLEANING_PAYMENT_WATCH_INTERVAL_MS`,
  1 heure) et chaque paiement enregistré.
- **Suspension** : passages planifiés annulés (cause `suspension`), agents libérés,
  planification refusée (`CLEANING_CONTRACT_SUSPENDED`).
- **Reprise** sous le seuil : reprogrammation automatique et déterministe des passages annulés
  par la suspension (même date si le délai minimum le permet, sinon même jour et même heure des
  semaines suivantes ; agents d'origine s'ils sont libres, sinon agents actifs libres par
  identifiant), dans la transaction qui verrouille les agents ; à défaut,
  `cleaning.rescheduling.failed` et replanification manuelle.
- Événements : `cleaning.contract.suspension_warning`, `cleaning.contract.suspended`,
  `cleaning.contract.resumed`, `cleaning.rescheduling.failed`, plus `cleaning.mission.scheduled`
  pour chaque passage reprogrammé.

## Organisation suspendue par KSP (ADR-030)

- cleaning consomme `identity.organization.suspended` et `identity.organization.reactivated`
  (inbox, table `organization_standings` ; une décision plus ancienne que la dernière appliquée
  est sans effet) et aligne les missions non terminées de l'organisation.
- **Suspension** : cause `organization_suspended`, mêmes effets que les impayés (passages
  planifiés annulés, agents libérés, planification refusée). **Réactivation** : la cause est
  levée ; la mission reprend (reprogrammation automatique) s'il ne reste aucune autre cause.
- **Causes cumulées** (`suspension.causes`, colonne `suspension_causes`) : un règlement ne lève
  pas la suspension de l'organisation, une réactivation ne lève pas celle des impayés. Seul le
  début de la suspension publie `cleaning.contract.suspended`, seule la levée de la dernière cause
  publie `cleaning.contract.resumed` (cause levée en dernier) ; entre les deux, chaque cause
  ajoutée ou levée publie `cleaning.contract.suspension_updated` (le client est prévenu). Pas
  d'avertissement d'impayé pendant la suspension ; à la réactivation, des impayés au seuil
  prennent le relais sans reprise intermédiaire. Deux décisions de même date : la suspension
  l'emporte.
- Ni demande de devis dans le contexte d'une organisation suspendue, ni acceptation d'un devis
  demandé pour elle : `CLEANING_ORGANIZATION_SUSPENDED` (verrou de l'organisation pris par
  l'acceptation et par l'enregistrement d'une décision).

## Back-office (ADR-029)

- **Rôles** : `cleaning_supervisor`, `cleaning_agent` (ses passages), `cleaning_admin` ;
  `super_admin` a partout la portée de `cleaning_admin`. Double authentification exigée.
- **Noms affichés** : client, organisation, agent de visite, auteur d'un paiement ou d'un
  réglage, lus dans identity à chaque réponse (`GetUsersByIds`, `GetOrganizationsByIds`, sans
  coordonnées). identity indisponible : noms absents, réponse rendue quand même. Variables
  `IDENTITY_GRPC_URL`, `IDENTITY_TOKEN_URL`, `SERVICE_CLIENT_SECRET` (obligatoires en
  production) ; entrée `cleaning` (audience `identity`) dans `SERVICE_CLIENTS` d'identity.
- **Liste des demandes** : filtres cumulables état, zone (`commune`, code de zone, colonne
  `commune_code`) et type de client (`customerKind`), paginés par curseur.
- **Paiement manuel** idempotent par `Idempotency-Key` facultative (unicité mission + clé) ;
  au-delà du dû, le message et `details.remainingDue` donnent le reste dû.
- **Dates du terrain** (fuseau `CLEANING_TIME_ZONE`, `Africa/Porto-Novo`) : démarrer un passage
  avant son jour prévu est refusé (`CLEANING_INTERVENTION_TOO_EARLY`,
  `CLEANING_BLOCK_EARLY_INTERVENTION_START`) ; le compte rendu d'une visite avant son heure
  prévue aussi (`CLEANING_VISIT_TOO_EARLY`, `CLEANING_BLOCK_EARLY_VISIT_REPORT`). `false`
  désactive la règle.

## Organisation

| Dossier              | Contenu                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `src/domain`         | Simulateur, états et transitions, devis, récurrence, créneaux, paiement    |
| `src/application`    | Un cas d'usage par classe (UC-CL-01 à 12), ports, doublures en mémoire     |
| `src/infrastructure` | Dépôts Prisma, outbox, verrous de planification                            |
| `src/interfaces`     | Contrôleurs gRPC (catalogue, devis, missions, back-office, obligations)    |
| `test`               | Module, gRPC de bout en bout, intégration PostgreSQL (`TEST_DATABASE_URL`) |
