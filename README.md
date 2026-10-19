# ksp_back

Backend de l'écosystème **KSP** : services NestJS indépendants, qui communiquent en gRPC (questions) et par événements RabbitMQ (faits). Les fronts (`ksp-portail`, `ksp-shop`, `ksp-print`, `ksp-backoffice`, `ksp-courier`) n'appellent que la `gateway`.

## Contenu du dépôt

```
ksp-backend/
├── contracts/
│   ├── proto/ksp/<service>/v1/*.proto   contrats gRPC (paquet ksp.<service>.v1)
│   ├── events/<service>/*.schema.json   schémas des événements (+ enveloppe commune)
│   ├── openapi/ksp-api.v1.yaml          API REST publique de la gateway (OpenAPI 3.1)
│   └── tokens/*.schema.json             contenu des jetons (jeton d'accès, ADR-020)
├── libs/
│   ├── contracts/     @ksp/contracts : code TypeScript généré depuis les contrats
│   └── platform/      @ksp/platform  : kit technique commun, aucun code métier
├── services/<service>/                  un dossier par service (architecture hexagonale)
├── tools/
│   ├── new-service/   générateur de service
│   └── ci/            scripts de la CI
├── infra/local/       initialisation de l'environnement local
├── docs/
│   ├── architecture/  vue d'ensemble et conventions
│   └── adr/           registre des décisions d'architecture
└── docker-compose.yml dépendances locales (PostgreSQL, RabbitMQ, Redis, MinIO, Jaeger)
```

## Services

| Groupe                             | Services                                                                                                  | Phase |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ----- |
| Socle                              | `gateway`, `identity`, `payment`, `wallet`, `billing`, `notification`, `file`, `document`, `cms`, `audit` | 1     |
| Recouvrement, nettoyage            | `recovery`, `cleaning`                                                                                    | 1     |
| Immobilier                         | `realestate`                                                                                              | 2     |
| Marketplace, impression, livraison | `catalog`, `order`, `print`, `delivery`                                                                   | 3     |

Services présents dans le dépôt : `identity` (squelette, contrat exposé, cas d'usage à venir au lot 1).

## Démarrer

Prérequis : Node.js 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install
pnpm prisma:generate          # génère le client Prisma de chaque service
pnpm infra:up                 # PostgreSQL, RabbitMQ, Redis, MinIO, Jaeger

cp services/identity/.env.example services/identity/.env
pnpm --filter @ksp/identity-service exec prisma migrate deploy
pnpm --filter @ksp/identity-service dev
```

Chaque service expose :

- gRPC sur son port (`identity` : 50051) ;
- HTTP technique (`identity` : 3101) : `/health/live`, `/health/ready`, `/metrics`.

Consoles locales : RabbitMQ http://localhost:15672 (ksp / ksp), MinIO http://localhost:9001, traces Jaeger http://localhost:16686.

## Commandes

| Commande                          | Rôle                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `pnpm typecheck`                  | Vérification des types de tout le dépôt                                    |
| `pnpm test`                       | Tests unitaires (et tests d'intégration si `TEST_DATABASE_URL` est défini) |
| `pnpm lint` · `pnpm format:check` | Règles de code et format                                                   |
| `pnpm build`                      | Compilation de toutes les bibliothèques et services                        |
| `pnpm contracts:lint`             | Vérifie les `.proto`                                                       |
| `pnpm contracts:breaking`         | Détecte une rupture de compatibilité par rapport à `main`                  |
| `pnpm contracts:generate`         | Régénère `libs/contracts/src/generated` après une modification de `.proto` |
| `pnpm prisma:generate`            | Génère le client Prisma de chaque service                                  |
| `pnpm new-service <nom>`          | Crée un service complet et conforme                                        |

## Créer un service

```bash
pnpm new-service notification
```

Le générateur crée `services/notification` (couches, configuration, Dockerfile, migration initiale outbox/inbox, test), un contrat `contracts/proto/ksp/notification/v1/notification.proto` s'il n'existe pas, enregistre le paquet gRPC dans `@ksp/contracts`, attribue les ports dans `tools/services.json` et ajoute la base locale dans `infra/local/postgres-init.sql`. Ensuite : `pnpm install`, puis `docker compose down -v && pnpm infra:up` pour recréer les bases locales.

## Documentation

- [Vue d'ensemble et conventions](docs/architecture/README.md)
- [Décisions d'architecture (ADR)](docs/adr/README.md)
- [Règles de travail](CONTRIBUTING.md)
