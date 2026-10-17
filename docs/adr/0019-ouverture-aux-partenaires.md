# ADR-019 — Ouverture aux solutions partenaires

**Statut** : Accepté

## Contexte

KSP Shop est une marketplace en SaaS : des commerçants y créent leur boutique. Pour livrer leurs clients, KSP ne veut pas un seul livreur mais plusieurs solutions de livraison partenaires (ForYou, puis d'autres), sur le modèle des transporteurs d'une grande marketplace. Chaque partenaire a son propre système, son langage et sa base (ForYou : Express et MongoDB).

Modèle économique validé :

- chaque partenaire fixe lui-même ses prix de livraison ;
- le client paie d'avance le panier et la livraison : ce paiement valide la commande ;
- KSP prélève un pourcentage sur chaque livraison faite par un partenaire, et une commission sur chaque vente des commerçants.

## Décision

1. **Une seule porte pour les partenaires : l'API Partenaires**, exposée par la gateway sous `/partner/v1` (REST, OpenAPI public, versionné). Un partenaire n'accède jamais à RabbitMQ, au gRPC interne ni à une base KSP.
2. **Un contrat standard par capacité, écrit par KSP** et implémenté par les partenaires. Livraison v1 : devis, création, annulation et suivi d'une course ; le partenaire pousse ses changements de statut. Brancher un partenaire conforme ne demande aucun code, seulement de la configuration. Un adaptateur spécifique reste possible en exception.
3. **Un port fournisseur dans chaque service métier ouvert** (ADR-007) : `delivery` dépend d'une interface `DeliveryProvider` ; l'adaptateur standard sert tous les partenaires conformes.
4. **Devis multi-partenaires** : au moment du panier, `delivery` interroge en parallèle les partenaires qui couvrent la zone, avec un délai maximum. Chaque devis porte un identifiant et une date d'expiration ; le partenaire s'engage sur ce prix. Un partenaire qui ne répond pas à temps n'est simplement pas proposé.
5. **Attribution et suivi dans `delivery`** : après le paiement, la course est créée chez le partenaire du devis retenu. Les autres services ne savent pas qui livre : ils ne voient que les événements `delivery.job.*`.
6. **Comptes partenaires dans `identity`** : un partenaire est une organisation avec un profil fournisseur et des identifiants machine (remplaçables, révocables, limités à ses capacités, par exemple `delivery:provider`). Aucun nouveau service : l'ADR-001 reste valable.
7. **KSP → partenaire par webhooks signés** (une clé secrète par partenaire), émis par l'outbox, donc renvoyés jusqu'à réussite.
8. **Entrée d'un partenaire** : inscription, bac à sable, tests de conformité automatisés fournis par KSP, activation en production.
9. **Argent** : `payment` encaisse le panier et la livraison ; `wallet` garde les fonds jusqu'à la livraison puis verse sa part au partenaire (prix de la livraison moins le pourcentage KSP) et au commerçant (ventes moins la commission) ; `billing` facture les commissions.
10. **Même modèle pour les autres activités** : livraison d'abord ; impression (imprimeurs sous-traitants) et nettoyage (prestataires) le réutiliseront.

## À valider

- Présentation au client : choix entre les offres (prix, délai, nom du partenaire) ou attribution automatique par KSP.
- Panier avec des articles de plusieurs boutiques : une course par boutique (plusieurs points de retrait), devis additionnés.
- Paiement à la livraison : exclu, le client paie toujours d'avance.
- Échec de livraison, retour et annulation : qui rembourse quoi, et qui paie le retour.
- Taux de commission (fixes, par partenaire, par catégorie de produit) et rythme des versements.
- Responsabilités : colis perdu ou abîmé, réclamations, engagement de délai du partenaire.

## Alternatives écartées

- **Partenaire branché sur RabbitMQ ou en gRPC interne** : nos services ne pourraient plus évoluer librement, et un partenaire mal sécurisé exposerait tout KSP.
- **Un connecteur écrit par KSP pour chaque partenaire** : ne passe pas à l'échelle ; réservé aux exceptions.
- **Un 18ᵉ service dédié aux partenaires** : les briques existent déjà (`identity`, `gateway`, `delivery`, `wallet`, `billing`) ; à reconsidérer si plusieurs activités s'ouvrent en même temps.

## Conséquences

- La gateway a une quatrième façade, `/partner/v1`, à côté de web, mobile et admin.
- `identity` délivrera des identifiants machine aux partenaires (après le lot 1).
- `delivery` est conçu autour du port fournisseur dès sa création (phase 3).
- Le contrat Livraison v1 et ses tests de conformité vivent dans `contracts/partner/`.
- ForYou devient le premier partenaire : il implémente le contrat standard, ce qui valide le standard avant d'en accueillir d'autres.
