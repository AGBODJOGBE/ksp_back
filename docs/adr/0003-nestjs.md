# ADR-003 — NestJS (TypeScript) pour tous les services

**Statut** : Accepté

## Contexte

Il faut un cadre unique, connu des développeurs du marché local, avec gRPC, injection de dépendances et tests.

## Décision

Tous les services sont écrits en NestJS 11 sur Node.js 22, en TypeScript strict.

## Alternatives écartées

- **Go** : performant mais vivier plus réduit et deux langages avec les fronts.
- **Express nu** : trop de choses à réinventer à chaque service.

## Conséquences

- Un seul langage du backend aux fronts (Next.js).
- Le domaine reste du TypeScript pur, sans dépendance à NestJS (ADR-007).
