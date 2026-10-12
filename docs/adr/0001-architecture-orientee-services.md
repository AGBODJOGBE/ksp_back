# ADR-001 — Architecture orientée services : 17 services

**Statut** : Accepté

## Contexte

L'écosystème KSP réunit six activités (recouvrement, immobilier clés en main, marketplace, nettoyage, impression, livraison) qui partagent des briques communes (comptes, paiement, notifications, fichiers). Les activités démarrent à des moments différents et évolueront à des rythmes différents.

## Décision

Le backend est découpé en services indépendants, un par domaine :

- **Socle (10)** : `gateway`, `identity`, `payment`, `wallet`, `billing`, `notification`, `file`, `document`, `cms`, `audit`.
- **Métier (7)** : `recovery`, `cleaning`, `realestate`, `catalog`, `order`, `print`, `delivery`.

Un service qui a besoin d'une capacité appelle le service qui la porte ; il ne la réimplémente pas.

## Alternatives écartées

- **Monolithe modulaire** : plus simple au départ, écarté par le porteur du projet, qui veut des services autonomes dès le départ.
- **Découpage plus fin** (un service par entité) : coût d'exploitation sans bénéfice.

## Conséquences

- Chaque service a sa base, son image, son déploiement et ses contrats.
- La cohérence entre services passe par des événements et des sagas, jamais par une base partagée.
- L'exploitation demande une supervision sérieuse dès le premier jour (ADR-008).
