# ADR-063 — Chiffrement des champs et empreintes de recherche dans le kit commun

**Statut** : Accepté (2026-11-20)

## Contexte

Le Recouvrement et la gestion locative (cahier des charges du 2026-11-19, partie 17.3) gardent des
données sur des personnes qui n'ont pas de compte KSP : coordonnées des débiteurs et des locataires,
pièces d'identité, preuves de propriété. Ces données doivent être **chiffrées en base**, jamais écrites
dans les journaux, les traces ni les événements (identifiants seulement). Il faut aussi détecter un
dossier ouvert pour le même débiteur (R-SD-06) sans déchiffrer toute la table.

Seul `identity` chiffrait jusqu'ici, avec une classe propre (`AesGcmSecretCipher`, secrets de double
authentification, ADR-023) : clé unique, sans identifiant, donc sans rotation possible. Recopier cette
classe dans chaque service multiplierait les variantes d'un code de sécurité.

Le kit `@ksp/platform` ne contient aucune règle métier ; un chiffrement de champs et une empreinte de
recherche sont du code technique, comme la vérification des jetons ou l'outbox.

## Décision

1. **`FieldCipher` dans `@ksp/platform`** : AES-256-GCM, vecteur d'initialisation aléatoire de
   12 octets, étiquette complète de 16 octets. Format écrit, en base64url :
   `v2.<id de clé>.<iv>.<chiffré>.<étiquette>`. Les **données associées** sont
   `v2.<id de clé>.<contexte>` : la version et l'identifiant de clé sont liés au chiffré, et le
   **contexte** (propriétaire, ligne ou champ, par exemple `debtor:<id>:phone`) empêche de déchiffrer
   un chiffré recopié sur une autre ligne. Toute lecture impossible lève `FieldDecryptionError`, sans
   détail sur la cause.
2. **Rotation par trousseau.** Une variable contient soit une clé seule (32 octets en base64,
   identifiant implicite `default`), soit une liste `id:clé` séparée par des virgules : **la première
   chiffre**, toutes relisent. Pour changer de clé, on ajoute la nouvelle en tête et on garde les
   anciennes tant que des données en dépendent ; `needsReencryption` signale un chiffré à réécrire
   (ancien format ou ancienne clé). Identifiants : `a-z`, `0-9`, `_` et `-`, 32 caractères au plus,
   uniques ; `ephemeral` est réservé à la clé temporaire.
3. **Relecture de l'ancien format v1** (`v1.<iv>.<chiffré>.<étiquette>`, données associées = contexte
   seul) : celui des secrets de double authentification déjà enregistrés par `identity`. Il n'a pas
   d'identifiant de clé : chaque clé du trousseau est essayée, l'étiquette désigne la bonne. Il n'est
   jamais écrit. `identity` utilise désormais `FieldCipher` ; sa variable `IDENTITY_MFA_ENCRYPTION_KEY`
   ne change pas et accepte en plus un trousseau.
4. **`BlindIndex` : empreinte de recherche** (« index aveugle »). HMAC-SHA256 de
   `<finalité>\0<valeur normalisée>`, au format `<id de clé>.<empreinte en base64url>`. La **finalité**
   (`debtor_phone`, `tenant_email`…) rend deux colonnes incomparables entre elles. La clé HMAC est
   **dérivée par HKDF-SHA256** de la clé configurée (étiquette `ksp/platform/blind-index/hmac-sha256`) :
   même configurée par erreur avec la clé d'un `FieldCipher`, elle ne servirait jamais aux deux usages.
   Normalisation fournie : téléphone en E.164 (espaces, points, tirets et parenthèses retirés, `00`
   lu comme `+`, aucun indicatif deviné), e-mail en minuscules sans espaces. **Numéros du Bénin**
   (validé le 2026-11-20) : la numérotation béninoise est passée à 10 chiffres fin 2024 en ajoutant
   `01` devant les 8 chiffres ; un numéro `+229` à 8 chiffres est donc normalisé en `+229 01` suivi des
   8 chiffres, un numéro à 10 chiffres reste tel quel, et les deux formes d'un même numéro donnent la
   même empreinte. Les numéros des autres pays ne changent pas. La même normalisation sera appliquée
   à `identity` dans une branche séparée. Changer de clé active
   demande de recalculer les empreintes ; pendant la rotation, `compute` accepte un ancien identifiant
   de clé.
5. **Une variable de clé distincte par usage et par service**, fournie par le coffre à secrets, jamais
   partagée : par exemple `RECOVERY_FIELD_ENCRYPTION_KEYS` et `RECOVERY_BLIND_INDEX_KEYS` (noms fixés
   par le service). Le schéma de configuration la déclare avec `fieldKeyringEnv(variable)`, qui vérifie
   son format dès la lecture de la configuration ; une erreur ne reprend jamais une clé ni une entrée
   illisible, seulement sa position ou son identifiant validé.
6. **Clé temporaire hors production, refus en production.** Hors production, une variable vide donne
   une clé tirée au démarrage et un avertissement journalisé : ce qui est chiffré ou indexé avec elle
   devient illisible au redémarrage. En production, une variable absente ou vide est refusée **dès la
   lecture de la configuration** (`requireFieldKeysInProduction` dans le `superRefine` du service) :
   le service ne démarre pas. Une clé de développement du `.env.example` est refusée en production,
   même recopiée sous un autre identifiant dans un trousseau (`refuseDevelopmentSecrets`, règle
   d'ADR-050).
7. **Ce que l'on chiffre** : téléphones, e-mails, adresses, identifiants légaux et pièces d'identité des
   débiteurs et des locataires, preuves de propriété, et tout secret applicatif (double
   authentification). Les documents eux-mêmes restent dans `file` (accès par adresse présignée). Ces
   valeurs n'apparaissent **jamais** dans les journaux, les traces ni les événements, qui ne portent que
   des identifiants ; les recherches exactes passent par l'empreinte.

## Alternatives écartées

- **Chiffrement par la base** (`pgcrypto`) : la clé transiterait dans les requêtes et les journaux
  de PostgreSQL, et chaque requête devrait la porter.
- **Chiffrement du disque seul** : ne protège pas contre une fuite de sauvegarde ou un accès en lecture
  à la base.
- **Copier `AesGcmSecretCipher` dans chaque service** : plusieurs variantes d'un code de sécurité, sans
  rotation.
- **Empreinte SHA-256 sans clé** : un téléphone béninois se retrouve par force brute en quelques
  secondes (l'espace des numéros est petit) ; le HMAC à clé secrète l'empêche.
- **Même clé pour le chiffrement et l'empreinte** : une seule fuite compromettrait les deux usages ;
  variables distinctes, et dérivation HKDF en défense supplémentaire.

## Conséquences

- `@ksp/platform` exporte `FieldCipher`, `BlindIndex`, `normalizePhone`, `normalizeEmail`,
  `parseFieldKeyring`, `fieldKeyringFromConfig`, `fieldKeyringEnv`, `requireFieldKeysInProduction`,
  `refuseDevelopmentSecrets` et leurs erreurs.
- `identity` : `AesGcmSecretCipher` est supprimée ; les nouveaux secrets de double authentification sont
  écrits en v2, les anciens restent lisibles. Revenir à une version antérieure d'`identity` rendrait
  illisibles les secrets écrits en v2.
- Les services qui chiffrent (`recovery` en premier, `rental` ensuite) déclarent leurs deux variables,
  les ajoutent au `.env.example` et à `DEV_SECRETS`, et chiffrent avec un contexte propre à chaque champ.
- Une colonne chiffrée ne se trie ni ne se filtre par fragment : seules les recherches exactes (par
  empreinte) sont possibles.

## À valider

- **Rechiffrement des anciens secrets de double authentification en v2** à la prochaine vérification
  réussie (`needsReencryption`), pour pouvoir retirer un jour la relecture v1. Non mis en œuvre.
- **Format v1 réservé à `identity`** : la relecture v1 reste dans `FieldCipher` pour tous les services ;
  proposition de la réserver à `identity` (option à l'appel) une fois les anciens secrets rechiffrés.
