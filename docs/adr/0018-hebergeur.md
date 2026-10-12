# ADR-018 — Choix de l'hébergeur

**Statut** : À trancher

## Contexte

Il faut un hébergeur pour k3s, PostgreSQL géré et un stockage compatible S3.

## Décision

À décider selon cinq critères : PostgreSQL géré, stockage S3, latence depuis le Bénin, coût, localisation des données.

## Alternatives écartées

À comparer.

## Conséquences

Bloque le déploiement en préproduction, pas le développement : tout tourne en local avec `docker compose`.
