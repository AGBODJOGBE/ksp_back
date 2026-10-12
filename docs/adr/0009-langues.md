# ADR-009 — Code en anglais, documentation en français

**Statut** : Accepté

## Contexte

L'équipe et les utilisateurs sont francophones ; les outils et bibliothèques sont en anglais.

## Décision

Code, contrats, noms d'événements et de tables en anglais. Documentation, commentaires, messages d'erreur destinés aux utilisateurs et tests (descriptions) en français.

## Alternatives écartées

- **Tout en français** : mélange permanent avec les API des bibliothèques.

## Conséquences

- Les codes d'erreur sont en anglais (`IDENTITY_OTP_EXPIRED`), leurs messages en français.
