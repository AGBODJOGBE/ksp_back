# ADR-012 — Payload CMS pour le service cms

**Statut** : Accepté

## Contexte

Les fronts publics ont besoin de pages et de contenus éditables sans développeur.

## Décision

Le service `cms` intègre Payload CMS avec sa propre base. Alternative de repli : Strapi.

## Alternatives écartées

- **CMS SaaS** : coût récurrent et données hors de notre contrôle.

## Conséquences

- Payload est en TypeScript, cohérent avec le reste du backend.
