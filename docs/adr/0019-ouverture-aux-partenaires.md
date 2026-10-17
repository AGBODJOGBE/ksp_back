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
4. **Devis multi-partenaires** : au moment du panier, `delivery` interroge en parallèle les partenaires qui couvrent la zone, avec un délai maximum. Chaque devis porte un identifiant et une date d'expiration ; le partenaire s'engage sur ce prix. Un partenaire qui ne répond pas à temps n'est simplement pas proposé. Le client choisit son offre (prix, délai, nom du partenaire) ; KSP présélectionne la moins chère à délai égal.
5. **Attribution et suivi dans `delivery`** : après le paiement, la course est créée chez le partenaire de l'offre choisie. Les autres services ne savent pas qui livre : ils ne voient que les événements `delivery.job.*`.
6. **Comptes partenaires dans `identity`** : un partenaire est une organisation avec un profil fournisseur et des identifiants machine (remplaçables, révocables, limités à ses capacités, par exemple `delivery:provider`). Aucun nouveau service : l'ADR-001 reste valable.
7. **KSP → partenaire par webhooks signés** (une clé secrète par partenaire), émis par l'outbox, donc renvoyés jusqu'à réussite.
8. **Entrée d'un partenaire** : inscription, bac à sable, tests de conformité automatisés fournis par KSP, activation en production.
9. **Argent** : `payment` encaisse le panier et la livraison ; `wallet` garde les fonds jusqu'à la confirmation de la livraison puis verse sa part au partenaire (prix de la livraison moins le pourcentage KSP) et au commerçant (ventes moins la commission) ; `billing` facture les commissions. Détail dans les règles ci-dessous.
10. **Même modèle pour les autres activités** : livraison d'abord ; impression (imprimeurs sous-traitants) et nettoyage (prestataires) le réutiliseront.

## Règles de commande, de livraison et d'argent

Les durées et le nombre de tentatives sont des paramètres de configuration ; les valeurs ci-dessous sont celles de départ.

**Panier multi-boutiques** (modèle Amazon pour les vendeurs qui expédient eux-mêmes) : un seul paiement, mais une sous-commande et un colis par boutique, chacun avec ses offres de livraison, son suivi, sa confirmation, son remboursement et le versement à son vendeur. Le client voit le total des livraisons. Plus tard : ramassage groupé proposé par un partenaire, livraison offerte par une boutique, expédition depuis des entrepôts partenaires.

**Paiement** : toujours d'avance ; pas de paiement à la livraison.

**Confirmation de livraison** : le client reçoit un code de remise et le donne au livreur. Sans code, la livraison n'est pas confirmée.

**Versements**, commissions KSP prélevées automatiquement à chaque versement :

- au partenaire, dès la confirmation : prix de la livraison moins le pourcentage KSP ;
- au commerçant, après un délai de réclamation de 3 jours : montant des ventes moins la commission.

**Annulations, échecs et retours** : celui qui cause le problème paie ; KSP rembourse le client d'abord, puis se rembourse en retenant la somme sur les versements suivants du responsable.

| Cas                                                                 | Client                                                                | Partenaire de livraison            | Commerçant                           |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- | ------------------------------------ |
| Annulation par le client avant le ramassage                         | Remboursé à 100 %                                                     | Rien                               | Rien                                 |
| Sous-commande non confirmée par le commerçant sous 48 h, ou rupture | Remboursé à 100 % (annulation automatique)                            | Rien                               | Rien ; noté contre sa boutique       |
| Faute du livreur : colis perdu, abîmé ou très en retard             | Remboursé à 100 %                                                     | Non payé ; paie la valeur du colis | Payé normalement                     |
| Faute du client : absent après 2 tentatives, refus sans motif       | Remboursé des articles, sans la livraison ni le retour                | Payé pour l'aller et le retour     | Récupère son colis                   |
| Produit défectueux ou non conforme, signalé dans les 3 jours        | Retour gratuit, remboursé à 100 %                                     | Payé pour l'aller et le retour     | Non payé ; paie l'aller et le retour |
| Changement d'avis après la livraison                                | Pas de retour, sauf si la politique affichée de la boutique l'accepte | —                                  | —                                    |

- Après le ramassage, une annulation devient un retour.
- Remboursement sur le moyen de paiement d'origine (Mobile Money), ou instantané sur le portefeuille KSP, au choix du client.

**Responsabilités** : le partenaire de livraison répond du colis entre le ramassage (état vérifié, photo) et la remise contre le code ; le commerçant répond de la conformité du produit. En cas de litige, le support KSP tranche sur les preuves : vérification et photos au ramassage, photo et code de remise à la livraison.

**À valider** : les taux de commission (sur la livraison et sur les ventes), uniques ou par partenaire et par catégorie de produit.

## Alternatives écartées

- **Partenaire branché sur RabbitMQ ou en gRPC interne** : nos services ne pourraient plus évoluer librement, et un partenaire mal sécurisé exposerait tout KSP.
- **Un connecteur écrit par KSP pour chaque partenaire** : ne passe pas à l'échelle ; réservé aux exceptions.
- **Un 18ᵉ service dédié aux partenaires** : les briques existent déjà (`identity`, `gateway`, `delivery`, `wallet`, `billing`) ; à reconsidérer si plusieurs activités s'ouvrent en même temps.

## Conséquences

- La gateway a une quatrième façade, `/partner/v1`, à côté de web, mobile et admin.
- `identity` délivrera des identifiants machine aux partenaires (après le lot 1).
- `delivery` est conçu autour du port fournisseur dès sa création (phase 3) ; `order` découpe chaque commande en sous-commandes par boutique ; `wallet` garde les fonds et applique les règles de versement et de remboursement.
- Le contrat Livraison v1 et ses tests de conformité vivent dans `contracts/partner/`.
- ForYou devient le premier partenaire : il implémente le contrat standard, ce qui valide le standard avant d'en accueillir d'autres.
