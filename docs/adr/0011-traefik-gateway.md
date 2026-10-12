# ADR-011 — Traefik en entrée du cluster ; gateway en NestJS ; pas de Kong

**Statut** : Accepté

## Contexte

Il faut une entrée HTTPS du cluster et une couche qui traduit REST en gRPC, vérifie les jetons et sert les fronts.

## Décision

Cloudflare (DNS, cache, protection) → Traefik (fourni avec k3s : HTTPS, routage) → service `gateway` en NestJS (REST → gRPC, agrégation par front, jetons, limites d'appels, WebSocket).

## Alternatives écartées

- **Kong** : une brique de plus à exploiter, alors que la logique de traduction doit de toute façon être écrite.

## Conséquences

- La gateway est un service comme les autres (même kit, même pipeline), sans base métier.
