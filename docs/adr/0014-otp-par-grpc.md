# ADR-014 — Codes de vérification envoyés par appel gRPC direct

**Statut** : Accepté

## Contexte

Un code de vérification ne doit jamais transiter par le broker ni apparaître dans un journal.

## Décision

`identity` envoie le code par appel gRPC direct `notification.SendNotification`. L'événement `identity.otp.requested` ne contient jamais le code, seulement la cible masquée.

## Alternatives écartées

- **Code dans l'événement** : le code serait stocké dans les files et visible de tous les consommateurs.

## Conséquences

- Les variables d'un message ne sont jamais journalisées (`REDACTED_PATHS`).
