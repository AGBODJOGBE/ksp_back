# ADR-022 — Jetons de service : flux OAuth 2.0 client credentials

**Statut** : Accepté

## Contexte

L'ADR-013 impose des jetons de service courts, signés par `identity` et vérifiés par chaque service (destinataire = service appelé, `token_use = service`). Le cahier des charges Identité précise le flux : « client credentials ». Restait à décider comment un service obtient son jeton, où vivent les secrets et qui a le droit d'appeler qui.

## Décision

1. **Route standard OAuth 2.0** `POST /oauth/token` (RFC 6749, section 4.4) sur le **port HTTP interne** d'`identity`, jamais exposée hors du cluster. Corps `application/x-www-form-urlencoded` : `grant_type=client_credentials`, `client_id`, `client_secret` (ou en-tête `Authorization: Basic`), `audience` (service appelé). Réponse `{ access_token, token_type: "Bearer", expires_in }`, sans mise en cache. Refus normalisés : `invalid_request`, `invalid_client` (401), `unsupported_grant_type`, `invalid_target` (RFC 8707).
   - Pas de gRPC : pour appeler `identity` en gRPC, il faut déjà un jeton de service.
   - Route standard : utilisable par n'importe quel langage.
2. **Secrets** : chaque service garde son secret (32 octets aléatoires) dans son propre secret k3s (`SERVICE_CLIENT_SECRET`). `identity` n'en connaît que l'empreinte SHA-256, dans `SERVICE_CLIENTS`, comparée en temps constant. Pas de table en base, comme pour les clés de signature (ADR-020). Un secret de 32 octets aléatoires n'a pas besoin d'un hachage lent.
3. **Carte des services appliquée** : `SERVICE_CLIENTS` donne, pour chaque service, la liste des services qu'il a le droit d'appeler. Un jeton pour un appel non prévu est refusé (`invalid_target`). Second verrou, en plus des règles réseau k3s.
4. **Durée de vie de 5 minutes**. Le kit (`ServiceTokenClient`) garde un jeton par service appelé, le renouvelle une minute avant son expiration, et partage une seule requête entre des demandes simultanées.
5. **`identity` signe ses propres jetons sur place** (au nom `identity`) pour ses appels sortants, sans aller-retour HTTP.
6. **Le contenu du jeton est un contrat** (`contracts/tokens/service-token.v1.schema.json`), testé comme le jeton d'accès. Signature par le même trousseau que les jetons d'accès (ADR-020) ; `token_use` et le destinataire empêchent toute confusion entre les deux.

## Configuration

| Variable                | Où                      | Contenu                                                                              |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `SERVICE_CLIENTS`       | identity                | `{ "<service>": { "secretSha256": "<hex>", "audiences": ["<service appelé>", …] } }` |
| `IDENTITY_TOKEN_URL`    | chaque service appelant | `http://identity:3101/oauth/token`                                                   |
| `SERVICE_CLIENT_SECRET` | chaque service appelant | Le secret, connu de ce seul service                                                  |
| `IDENTITY_JWKS_URL`     | chaque service appelé   | `http://identity:3101/.well-known/jwks.json` (ADR-020)                               |

Le script `pnpm --filter @ksp/identity-service keys:service-client <service> <services appelés…>` produit le secret et l'entrée `SERVICE_CLIENTS` correspondante.

## Alternatives écartées

- **Émission par gRPC** : impossible sans un premier jeton (voir ci-dessus).
- **Jetons de compte de service Kubernetes** : liés à k3s, et inutilisables par un système hors du cluster.
- **mTLS immédiat** : complexité d'exploitation trop forte au démarrage (ADR-013) ; reste envisageable plus tard.

## Conséquences

- Ajouter un service = générer son secret et ajouter son entrée dans `SERVICE_CLIENTS` d'identity, d'après la carte des services.
- En développement, sans `SERVICE_CLIENTS` ni `IDENTITY_JWKS_URL`, les appels entre services ne sont pas authentifiés (avertissement au démarrage) ; ils le sont obligatoirement en production.
