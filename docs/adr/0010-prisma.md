# ADR-010 — Prisma comme ORM

**Statut** : Accepté

## Contexte

Chaque service a besoin de migrations versionnées et d'un accès typé à sa base.

## Décision

Prisma 6, client généré dans le dossier du service (`prisma/generated`, non versionné). Migrations dans `services/<service>/prisma/migrations`, appliquées par une tâche de déploiement (`prisma migrate deploy`), jamais au démarrage.

## Alternatives écartées

- **TypeORM** : typage plus faible, migrations moins fiables.
- **Drizzle** : plus jeune, écosystème de migration moins mûr à la date du choix.

## Conséquences

- `prisma generate` télécharge les moteurs Prisma : il s'exécute sur le poste du développeur, en CI et dans l'image Docker, pas à l'installation des dépendances.
- Le kit commun ne dépend pas du client généré : l'outbox et l'inbox utilisent une interface SQL minimale.
