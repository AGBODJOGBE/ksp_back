# Service cleaning

Nettoyage & assainissement, refonte v2 (ADR-054) : un dossier = un lieu, devis unique, programme de séances, agents et planification, argent par le wallet. Cahier des charges Nettoyage v2. Contrat gRPC : `contracts/proto/ksp/cleaning/v1/cleaning.proto` (avec `ksp.common.v1.ObligationService`). Événements : `contracts/events/cleaning/`. Routes REST : contrat OpenAPI, étiquettes « Nettoyage ».

## État

La v1 est remplacée sur place (ADR-054, décision 3). **Le métier v2 est livré lot par lot** (lots A à G du cahier des charges, partie 18), chacun avec ses tests ; les reprises de la v1 sont listées dans `docs/adr/annexes/0054-reprises-de-la-v1.md`. En attendant son lot, chaque méthode gRPC répond `UNIMPLEMENTED` (code `CLEANING_NOT_IMPLEMENTED`, 501 à la gateway). `ObligationService` est livré (contrôle avant la suppression d'un compte, réservé à identity) : une lecture en échec répond une erreur, et identity refuse alors la suppression, jamais « rien en cours » sans contrôle.

Déjà en place : démarrage NestJS, configuration, santé et métriques, traces, client Prisma de la base v2, outbox (relais vers RabbitMQ et purge), écriture des événements v2 et du journal d'audit dans la transaction de l'état, adaptateurs vers identity (noms affichés), wallet (débit, remboursement), file (photos et pièces, par type d'objet) et geo (géocodage inverse).

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/cleaning-service exec prisma migrate reset --force   # base v2 remise à zéro (une fois, ADR-054)
pnpm --filter @ksp/cleaning-service build && node --env-file=.env dist/main.js
```

- gRPC : `localhost:50053` (adresse attendue par la gateway, `CLEANING_GRPC_URL`)
- Santé : `http://localhost:3103/health/live` et `/health/ready`
- Métriques : `http://localhost:3103/metrics`

### Données de démonstration (développement uniquement)

`prisma/demo/demo-data.sql` ajoute un jeu v2 minimal, aux **prix inventés** : frais de visite par défaut, zones Cotonou, Porto-Novo et Abomey-Calavi, catégorie « Maison », lieu « Villa », type « Sol », offre « Villa × Sol » et son tarif publié par tranches (exemple de la partie 4 du cahier des charges). Le script refuse de s'exécuter sans l'accord explicite `ksp.demo=on` ; il est rejouable :

```bash
PGOPTIONS='-c ksp.demo=on' psql postgresql://cleaning:cleaning@localhost:5432/cleaning \
  -f services/cleaning/prisma/demo/demo-data.sql
```

## Agents : permissions, rôle et compte chez identity

- **Catalogue des permissions** (R-RB-01) : la liste fermée est dans
  `src/application/rbac/permission-catalog.ts` (16 permissions du cahier des charges, rôles livrés
  par défaut). Elle est déclarée à identity à chaque démarrage (`RegisterCatalog`), hors du chemin
  critique : un échec est journalisé et réessayé avec une attente qui double
  (`CLEANING_CATALOG_REGISTRATION_RETRY_MS`, 5 s au départ, 10 minutes au plus ; 0 la désactive).
  Toute modification de la liste augmente `version` (un test le rappelle). identity n'écrase jamais
  un rôle existant : les rôles déjà présents chez lui gardent les permissions cochées au back-office.
- **Rôle `cleaning_agent`** (R-AG-01) : attribué par `identity.GrantRole` avant qu'un agent ne
  devienne actif (validation, réactivation), retiré par `RevokeRole` après sa désactivation ; la
  suspension le garde. L'attribution est notée sur l'agent (`agents.role_assignment_id`).
- **Agent créé par l'admin** (R-AG-02) : le compte est trouvé ou créé par son téléphone chez identity
  (`EnsureUserByPhone`) ; cleaning ne garde pas le numéro. Un agent dont le compte n'a jamais ouvert
  de session ne peut pas encore être validé (identity répond `IDENTITY_ACCOUNT_NOT_ACTIVE`).
- **Agent invité par l'admin** (R-AG-02, `InviteAgent`) : un lien d'inscription est envoyé au numéro
  par notification (`SendNotification`, modèle `cleaning.agent_invitation`, WhatsApp puis SMS). Le
  lien est `CLEANING_AGENT_APP_URL` suivi de `/invitations/<identifiant>` ; l'invitation vaut 7 jours.
  Le numéro n'est gardé que chiffré (table `agent_invitations`), avec une empreinte à clé
  (`CLEANING_BLIND_INDEX_KEYS`, obligatoire en production, distincte de la clé de chiffrement) ; il
  est effacé quand l'invitation est consommée. Un numéro n'a qu'une invitation en cours : l'inviter
  de nouveau la renouvelle et la renvoie. Un numéro dont le compte est déjà agent est refusé
  (`CLEANING_AGENT_ALREADY_REGISTERED`, compte lu par `identity.FindUserByPhone`).
  - L'invitation est enregistrée avant l'envoi. Envoi en échec : `NOTIFICATION_UNAVAILABLE` (503), à
    rejouer avec la même clé d'idempotence, sans seconde invitation. La clé d'envoi porte le numéro
    de la tentative : la même tant que notification n'a pas répondu, la suivante quand elle a répondu
    que tous les canaux ont échoué.
  - Inscription avec `invitationId` : l'invitation doit être en cours et avoir été envoyée au numéro
    du compte qui s'inscrit ; elle est consommée dans la transaction de l'inscription et l'événement
    `cleaning.agent.applied` porte `source = invited`. Sinon `CLEANING_VALIDATION_FAILED` sur le champ
    `invitationId`, motif `invitation_not_found` (inconnue ou envoyée à un autre numéro),
    `invitation_consumed` ou `invitation_expired`.
- **Pièce d'identité** : lue par l'admin Nettoyage seulement, adresses temporaires de file, chaque
  lecture écrite au journal d'audit (`agent.id_document_read`).
- identity injoignable pendant l'une de ces actions : `IDENTITY_UNAVAILABLE` (503), à rejouer avec la
  même clé d'idempotence.

## Organisation

| Dossier              | Contenu                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `src/domain`         | Entités et règles du Nettoyage v2, sans dépendance technique (lot par lot)                |
| `src/application`    | Ports (événements, audit, identity, wallet, file, geo), dépendances des cas d'usage       |
| `src/infrastructure` | Prisma, outbox, écriture des changements, adaptateurs gRPC vers les autres services       |
| `src/interfaces`     | Un contrôleur gRPC par service du contrat (`UNIMPLEMENTED` tant que son lot n'est pas là) |
| `test`               | Module, gRPC de bout en bout, intégration PostgreSQL (`TEST_DATABASE_URL`)                |
