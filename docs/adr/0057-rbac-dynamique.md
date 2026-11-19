# ADR-057 — RBAC dynamique : permissions déclarées par le code, rôles créés au back-office, portée zone

**Statut** : Proposé (2026-11-19)

## Contexte

Aujourd'hui, chaque service déclare à `identity` son catalogue de permissions **et de rôles** à chaque
déploiement (`RegisterCatalog`) ; les rôles sont donc fixés par le code. Le jeton d'accès porte les
rôles (`roles` : rôle, portée `global`, `domain`, `org` ou `personal`), et la gateway décide par rôle
route par route. L'administration des comptes (ADR-043) attribue ces rôles, avec un administrateur de
métier qui gère les rôles de son métier. `CheckPermission` existe pour les actions sensibles.

Le cahier des charges v2 (partie 2, R-RB-01 à 07) demande des rôles créés et modifiés par le super
administrateur, des droits égaux à l'union des permissions des rôles, une assignation limitée à des
zones (un superviseur de Porto-Novo), et un service qui revérifie les droits à chaque appel à partir
des **permissions portées par le jeton**, sans appel à `identity` (partie 16.3).

## Décision

1. **Permissions déclarées par le code** (R-RB-01). Chaque service enregistre à son déploiement son
   catalogue de permissions (code, description, sensible ou non) ; une permission correspond à un
   contrôle réel. Une permission disparue du catalogue est marquée retirée : elle n'entre plus dans le
   jeton et le back-office la signale dans les rôles qui la gardent.
2. **Rôles dynamiques** (R-RB-02) : créés, modifiés et désactivés au back-office par le super
   administrateur (nom, description, permissions cochées). Un rôle assigné ne se supprime pas : il se
   désactive après réaffectation. Les **rôles livrés par défaut** (`cleaning_admin`,
   `cleaning_supervisor`, `cleaning_agent`, `finance_officer`, `support_agent`) sont créés s'ils
   n'existent pas, jamais écrasés ensuite. `super_admin` n'est ni modifiable ni supprimable (R-RB-04).
3. **Assignation** (R-RB-03) : plusieurs rôles par compte du personnel ; droits = union des permissions.
   Nouvelle portée **`zone`** : une assignation peut viser une ou plusieurs communes, identifiées par la
   clé de commune de `geo` (ADR-059), pour qu'`identity` n'ait pas à connaître les zones du Nettoyage.
4. **Permissions dans le jeton d'accès** : nouvelle revendication facultative `perms` (ajout au schéma
   `access-token.v1`), permissions effectives groupées par portée (globale, ou liste de zones).
   `cleaning` contrôle chaque appel avec elles, sans appel à `identity` : permission absente → refus ;
   dossier hors des zones de l'appelant → 404, sans révéler son existence. La gateway contrôle la
   permission déclarée par chaque route du manifeste. `roles` reste dans le jeton pour les modules qui
   décident encore par rôle.
5. **Prise d'effet** (R-RB-05) : au renouvellement du jeton (15 minutes au plus). Le retrait d'un rôle
   **sensible** (rôle qui contient une permission marquée sensible, ou `super_admin`) ferme tout de
   suite les sessions de la personne.
6. **Garde-fous** (R-RB-04) : il reste toujours au moins un super administrateur actif (règle et verrou
   d'ADR-043, décision 4) ; personne ne s'attribue un rôle à soi-même.
7. **Traçabilité** (R-RB-06) : création, modification, assignation et retrait d'un rôle sont écrits
   dans le journal d'audit d'`identity`, dans la transaction (qui, quoi, quand, avant, après).
8. **Validation d'un agent** : `cleaning` donne le rôle `cleaning_agent` par `identity.GrantRole`
   (jeton de service), seule assignation faite par un service (R-AG-01).
9. **Authentification** (R-RB-07) : le personnel de bureau garde téléphone + code puis application
   d'authentification (ADR-023) ; l'agent de terrain se connecte par code SMS depuis un **appareil
   enregistré**, sans application d'authentification.

## Alternatives écartées

- **Rôles déclarés par le code** (situation actuelle) : chaque nouveau rôle demande un déploiement.
- **Permissions lues dans `identity` à chaque appel** : un appel de plus par requête et une dépendance
  à sa disponibilité ; `CheckPermission` reste pour les cas où 15 minutes de retard ne sont pas admises.
- **Rôles seuls dans le jeton**, permissions déduites par chaque service : chaque service devrait
  connaître la composition de rôles qui changent au back-office.
- **Zones du Nettoyage copiées dans `identity`** : une donnée métier dans le service des comptes ; la
  clé de commune de `geo` suffit.

## Conséquences

- `identity` : tables des rôles dynamiques et de leurs permissions, portée `zone` (énumération étendue,
  ajout pour le gRPC, rupture pour une réponse REST à déclarer selon ADR-054), écrans et routes de
  gestion des rôles, revendication `perms`, fermeture des sessions au retrait d'un rôle sensible.
- `RegisterCatalog` ne porte plus que les permissions ; les rôles qu'il déclarait deviennent les rôles
  livrés par défaut.
- `gateway` : permission par route du Nettoyage v2 dans le manifeste ; les autres modules gardent le
  contrôle par rôle tant qu'ils ne sont pas migrés.
- Taille du jeton : quelques dizaines de permissions ; à surveiller quand d'autres modules migreront.
- ADR-043 (décisions 3 et 7) et ADR-023 (décision 1, pour les agents de terrain) sont remplacés en
  partie.

## À valider

- Rôle de l'administrateur de métier (ADR-043, décision 3) : le cahier des charges réserve la création
  **et l'assignation** des rôles au super administrateur ; proposition : l'administrateur du Nettoyage
  ne garde que la validation des agents (décision 8).
- Liste des permissions sensibles (proposition : `cleaning.amounts.read`, `cleaning.quote.adjust_price`,
  `cleaning.settings.manage`, permissions de la finance et des rôles).
- Clé de commune utilisée comme identifiant de la portée `zone`.
- Appareil enregistré des agents de terrain : enregistrement, nombre d'appareils, révocation (UC à
  écrire dans le cahier des charges Identité).
