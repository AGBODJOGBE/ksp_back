# ADR-013 — Authentification entre services

**Statut** : Accepté

## Contexte

Un service ne doit accepter que les appels des services prévus par la carte des services.

## Décision

- Règles réseau k3s (_NetworkPolicies_) : un service ne joint que les services autorisés.
- Jetons de service courts, signés ES256 par `identity`, vérifiés par chaque service (`ServiceTokenVerifier` : audience = service appelé, `token_use = service`).
- Chiffrement mutuel (mTLS) plus tard.

## Alternatives écartées

- **mTLS immédiat via un maillage de services** : complexité d'exploitation trop forte au démarrage.

## Conséquences

- Le contexte de l'utilisateur voyage dans les métadonnées gRPC, à côté du jeton de service.
