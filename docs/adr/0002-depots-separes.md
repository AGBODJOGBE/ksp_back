# ADR-002 — Front et back séparés ; un dépôt backend unique

**Statut** : Accepté

## Contexte

Le porteur du projet veut le backend séparé des fronts, sans monorepo global.

## Décision

- `ksp-backend` : les 17 services, les contrats, le kit commun et la documentation d'architecture.
- `ksp-infra` : configuration k3s, déploiements, supervision, références aux secrets (jamais les secrets).
- Un dépôt par front : `ksp-ui`, `ksp-portail`, `ksp-shop`, `ksp-print`, `ksp-backoffice`, `ksp-courier`, `ksp-mobile`.

## Alternatives écartées

- **Un dépôt par service** : 17 dépôts à maintenir, contrats dupliqués, changements transverses lents. Reste possible plus tard pour un service confié à une équipe dédiée.
- **Monorepo front + back** : refusé.

## Conséquences

- Les contrats vivent avec les services qui les implémentent : un changement d'API et son code passent dans la même demande de fusion.
- La CI ne reconstruit que les services touchés (`tools/ci/changed-services.ts`).
