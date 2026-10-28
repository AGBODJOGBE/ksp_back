# Service cleaning

Nettoyage & assainissement (lot 2) : simulateur public, demandes de devis, devis, missions et passages, catalogue et grille tarifaire, agents et équipes. Contrat gRPC : `contracts/proto/ksp/cleaning/v1/cleaning.proto` (avec `ksp.common.v1.ObligationService`). Événements : `contracts/events/cleaning/`. Routes REST : contrat OpenAPI, étiquettes « Nettoyage ».

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/cleaning-service prisma:deploy   # crée les tables (grille vide)
pnpm --filter @ksp/cleaning-service build && node --env-file=.env dist/main.js
```

- gRPC : `localhost:50053` (adresse attendue par la gateway, `CLEANING_GRPC_URL`)
- Santé : `http://localhost:3103/health/live` et `/health/ready`
- Métriques : `http://localhost:3103/metrics`

### Données de démonstration (développement uniquement)

La grille tarifaire est vide tant que l'équipe Nettoyage ne l'a pas remplie au back-office : le simulateur répond alors `priced: false`. Pour essayer le simulateur en local, `prisma/demo/demo-data.sql` charge cinq prestations avec des **prix inventés** ; le script refuse de s'exécuter sans l'accord explicite `ksp.demo=on` :

```bash
PGOPTIONS='-c ksp.demo=on' psql postgresql://cleaning:cleaning@localhost:5432/cleaning \
  -f services/cleaning/prisma/demo/demo-data.sql
```

## Règles (cahier des charges, parties 4 et 9)

| Sujet      | Fonctionnement                                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulateur | `max(minimum, (quantité × prix unitaire + options) × coefficient de commune)` ; fourchette −10 % / +15 % arrondie à 500 FCFA ; entiers XOF. Rien n'est enregistré.                                                            |
| Grille     | Versionnée : chaque enregistrement crée une version datée avec son auteur ; un devis envoyé garde son prix.                                                                                                                   |
| Réglages   | Validité des devis (15 j), délai minimum (48 h), annulation sans frais (24 h), 5 demandes ouvertes, acompte 30 %, seuils d'impayés : modifiables au back-office.                                                              |
| Demande    | reçue → visite planifiée → devis envoyé → acceptée / refusée / expirée / annulée, ou refusée par KSP. Visite des lieux réalisée obligatoire avant tout devis.                                                                 |
| Mission    | Un passage pour une prestation ponctuelle, plusieurs pour un contrat récurrent (passages par semaine ou par mois, sur N mois) ; chaque passage a ses agents, sa liste de contrôle et ses références de photos (service file). |
| Conflits   | Un agent ne peut être affecté à deux passages qui se chevauchent, ni pendant une indisponibilité (`CLEANING_TEAM_UNAVAILABLE`) ; agents verrouillés pendant la planification.                                                 |
| Paiement   | Option choisie à l'acceptation (acompte ou totalité, avant ou après, espèces ou Mobile Money) ; état dû / acompte reçu / payé ; paiements manuels cochés par le superviseur ; paiement en ligne : port prévu (`payment`).     |
| Droits     | Client : ses demandes et missions (404 sinon) ; agent : les missions où il est affecté ; superviseur et admin : rôle et double authentification revérifiés par le service.                                                    |
| Traces     | Événements par l'outbox dans la transaction de l'état (identifiants seulement, jamais d'adresse) ; table `audit_log` pour les prix, devis, affectations et paiements.                                                         |

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
