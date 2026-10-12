# ADR-004 — Une base PostgreSQL par service

**Statut** : Accepté

## Contexte

Des services qui partagent une base finissent couplés par leur schéma.

## Décision

Chaque service possède sa base et son utilisateur PostgreSQL. Aucun service n'a de droits sur la base d'un autre (règle d'or n° 1).

## Alternatives écartées

- **Une base partagée avec un schéma par service** : la frontière n'est que conventionnelle.

## Conséquences

- Les données d'un autre service s'obtiennent par gRPC ou par ses événements.
- Les rapports transverses passent par des projections alimentées par événements.
