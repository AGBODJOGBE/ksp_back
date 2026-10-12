# ADR-017 — PostgreSQL géré hors du cluster ; RabbitMQ dans le cluster

**Statut** : Accepté

## Contexte

Les bases sont la donnée la plus précieuse ; leur exploitation (sauvegardes, restauration) doit être fiable.

## Décision

- PostgreSQL en service géré par l'hébergeur, hors du cluster. À défaut, CloudNativePG dans le cluster avec sauvegardes vers S3.
- RabbitMQ dans le cluster via l'opérateur officiel : 3 nœuds, files répliquées (_quorum queues_).

## Alternatives écartées

- **PostgreSQL dans le cluster sans opérateur** : sauvegardes et bascules à la main.

## Conséquences

- Le choix de l'hébergeur (ADR-018) doit offrir PostgreSQL géré.
