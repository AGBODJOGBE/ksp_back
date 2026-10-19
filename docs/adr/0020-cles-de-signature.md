# ADR-020 — Clés de signature des jetons

**Statut** : Accepté

## Contexte

`identity` signe les jetons d'accès (ES256) lus par la gateway, et bientôt les jetons de service (ADR-013) lus par tous les services. Le cahier des charges Identité impose des clés privées dans le coffre à secrets, jamais en base ni dans le code, et une rotation sans interruption. Il prévoit aussi une table `signing_keys` (clé publique, référence de la clé privée, statut).

Ce choix doit tenir dans la durée : demain, un service de clés de l'hébergeur (KMS) pourra signer lui-même, sans que la clé privée en sorte.

## Décision

1. **Un port « signataire »** (`TokenSigner` : signer, lister les clés publiques). L'implémentation actuelle (`KeyRingSigner`) lit les clés privées dans le coffre ; une implémentation KMS pourra la remplacer sans toucher au reste du service.
2. **Pas de table `signing_keys`** : les clés viennent d'une seule source, le secret `IDENTITY_SIGNING_KEYS` (liste JSON `kid`, `status`, `privateKeyPem`). La clé publique se déduit de la clé privée. C'est un écart volontaire au cahier des charges : une table n'aurait contenu qu'une copie de ce que le secret porte déjà.
3. **Trois statuts** : `next` (publiée, ne signe pas encore), `active` (signe, exactement une), `retired` (publiée jusqu'à l'expiration des jetons qu'elle a signés). Le service refuse de démarrer si la liste est invalide.
4. **Rotation** (tous les 90 jours) :
   1. `keys:generate` produit une clé `next`, ajoutée au secret ; redéploiement progressif.
   2. Après au moins 10 minutes (durée du cache des vérificateurs), elle devient `active` et l'ancienne `retired`.
   3. Après la durée de vie d'un jeton (15 minutes), la clé `retired` est retirée du secret.
5. **Un seul chemin pour les clés publiques** : `identity` les publie sur son port HTTP interne (`/.well-known/jwks.json`). La gateway et tous les services les lisent par cette adresse (`IDENTITY_JWKS_URL`) avec `jose`, qui les garde en cache et recharge le document si un jeton porte une clé inconnue. La gateway relaie ce document en public. `GetSigningKeys` (gRPC) reste dans le contrat mais n'est pas le chemin principal.
6. **Le jeton d'accès est un contrat** (`contracts/tokens/access-token.v1.schema.json`, profil RFC 9068 : en-tête `typ: at+jwt`, identifiant unique `jti`, `token_use: access`). On y ajoute des champs, on n'en renomme ni n'en retire jamais. La vérification est écrite une seule fois, dans le kit (`AccessTokenVerifier`), et un test vérifie qu'un jeton émis par `identity` la passe et respecte le contrat.
7. **Hors production**, sans clé configurée, une clé temporaire est générée au démarrage ; les sessions ne survivent pas à un redémarrage.

## Alternatives écartées

- **Table `signing_keys` en plus du secret** : deux sources à garder synchronisées, sans gain.
- **Clés privées chiffrées en base** : contraire au cahier des charges, et la clé de chiffrement resterait un secret à gérer.
- **Clés publiques par gRPC pour la gateway et par HTTP pour les services** : deux mécanismes de cache et de rechargement à maintenir.

## Conséquences

- La rotation est une procédure d'exploitation, à automatiser plus tard (avec le KMS).
- Les jetons de service (ADR-013) utiliseront le même signataire, avec `token_use: service` et un destinataire différent.
- Tant que le coffre de l'hébergeur n'est pas choisi (ADR-018), le secret est un secret k3s.
