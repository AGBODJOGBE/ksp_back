# Service cleaning

Nettoyage & assainissement, refonte v2 (ADR-054) : un dossier = un lieu, devis unique, programme de séances, agents et planification, argent par le wallet. Cahier des charges Nettoyage v2. Contrat gRPC : `contracts/proto/ksp/cleaning/v1/cleaning.proto` (avec `ksp.common.v1.ObligationService`). Événements : `contracts/events/cleaning/`. Routes REST : contrat OpenAPI, étiquettes « Nettoyage ».

## État

La v1 est remplacée sur place (ADR-054, décision 3). **Le métier v2 est livré lot par lot** (lots A à G du cahier des charges, partie 18), chacun avec ses tests ; les reprises de la v1 sont listées dans `docs/adr/annexes/0054-reprises-de-la-v1.md`. En attendant son lot, chaque méthode gRPC répond `UNIMPLEMENTED` (code `CLEANING_NOT_IMPLEMENTED`, 501 à la gateway) ; `ObligationService` aussi : identity refuse alors la suppression d'un compte (service injoignable), jamais « rien en cours » sans contrôle.

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

## Organisation

| Dossier              | Contenu                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `src/domain`         | Entités et règles du Nettoyage v2, sans dépendance technique (lot par lot)                |
| `src/application`    | Ports (événements, audit, identity, wallet, file, geo), dépendances des cas d'usage       |
| `src/infrastructure` | Prisma, outbox, écriture des changements, adaptateurs gRPC vers les autres services       |
| `src/interfaces`     | Un contrôleur gRPC par service du contrat (`UNIMPLEMENTED` tant que son lot n'est pas là) |
| `test`               | Module, gRPC de bout en bout, intégration PostgreSQL (`TEST_DATABASE_URL`)                |
