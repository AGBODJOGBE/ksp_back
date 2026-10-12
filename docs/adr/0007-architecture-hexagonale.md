# ADR-007 — Architecture hexagonale dans chaque service

**Statut** : Accepté

## Contexte

Le métier doit rester testable et indépendant de la base, du broker et de gRPC.

## Décision

Quatre couches : `domain` (TypeScript pur), `application` (un cas d'usage = une classe), `infrastructure` (Prisma, RabbitMQ, clients gRPC, prestataires), `interfaces` (contrôleurs gRPC, consommateurs). Les dépendances pointent vers le domaine ; ESLint l'impose.

## Alternatives écartées

- **Couches NestJS classiques** (contrôleur, service, dépôt) : le métier se mélange au cadre.

## Conséquences

- Chaque cas d'usage du cahier des charges correspond à une classe testée.
- Un peu plus de code au départ, compensé par le générateur de service.
