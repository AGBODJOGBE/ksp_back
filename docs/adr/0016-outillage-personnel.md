# ADR-016 — Outillage personnel non versionné

**Statut** : Accepté

## Contexte

Les développeurs utilisent leurs propres outils, assistants et notes locales.

## Décision

Les fichiers de configuration personnels ne sont jamais versionnés ni mentionnés dans les commits, demandes de fusion ou README. Ils sont exclus par `.git/info/exclude` ou par l'exclusion globale de git de chaque poste, et non par le `.gitignore` du dépôt.

## Alternatives écartées

- **Les lister dans `.gitignore`** : cela documente dans le dépôt des outils propres à chacun.

## Conséquences

- Le dépôt ne contient que ce qui sert à tous.
