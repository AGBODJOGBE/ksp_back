# ADR-015 — Pas de regroupement de déploiements

**Statut** : Accepté

## Contexte

On aurait pu regrouper plusieurs services dans un même processus pour économiser des ressources au départ.

## Décision

Chaque service est déployé séparément dès le premier jour.

## Alternatives écartées

- **Regroupement provisoire** : il devient permanent et masque les dépendances réelles.

## Conséquences

- Une image par service ; la CI construit chaque service modifié séparément.
