# Service gateway

Seule porte d'entrée des fronts : API REST `/api/v1/…` traduite en gRPC vers les services. Aucune base de données, aucune règle métier. Cahier des charges : Gateway (UC-GW-01 à 16). Contrat REST qui fait foi : `contracts/openapi/ksp-api.v1.yaml`. Décisions : ADR-006, ADR-011, ADR-013, ADR-020, ADR-022.

Ce service couvre le **lot 1** : les routes `identity` (inscription et connexion par téléphone, sessions, profil) et la publication des clés publiques.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/identity-service dev       # identity : gRPC 50051, HTTP 3101
pnpm --filter @ksp/gateway-service dev
```

- API : `http://localhost:3000/api/v1/…`, clés publiques : `/.well-known/jwks.json`
- Santé : `/health/live` et `/health/ready` (prêt = clés publiques d'identity en cache) ; métriques : `/metrics`

Essai rapide (application mobile : pas d'origine, en-tête `X-App-Version`) :

```bash
curl -s -X POST localhost:3000/api/v1/identity/otp/request \
  -H 'Content-Type: application/json' -H 'X-App-Version: 1.0.0' -d '{"phone":"+2290197000045"}'
```

## Routes du lot 1

| Route                                   | Appel gRPC                                          | Accès            | Limite (par minute) |
| --------------------------------------- | --------------------------------------------------- | ---------------- | ------------------- |
| `POST /api/v1/identity/otp/request`     | `AuthService/RequestOtp`                            | public           | 5 par IP            |
| `POST /api/v1/identity/otp/verify`      | `AuthService/VerifyOtp`                             | public           | 10 par IP           |
| `POST /api/v1/identity/token/refresh`   | `AuthService/RefreshSession`                        | jeton de renouv. | 60 par IP           |
| `POST /api/v1/identity/logout`          | `AuthService/Logout`                                | connecté         | 300 par utilisateur |
| `GET /api/v1/identity/me`               | `AccountService/GetMe`                              | connecté         | 300 par utilisateur |
| `PATCH /api/v1/identity/me`             | `AccountService/UpdateMe`                           | connecté         | 300 par utilisateur |
| `PUT /api/v1/identity/me/email`         | `AccountService/ChangeEmail`                        | connecté         | 3 par utilisateur   |
| `POST /api/v1/identity/me/email/verify` | `AccountService/ConfirmEmail`                       | connecté         | 10 par utilisateur  |
| `GET /.well-known/jwks.json`            | cache de la gateway (JWKS HTTP d'identity, ADR-020) | public           | 60 par IP           |

E-mail du profil (lot 2) : `PUT /api/v1/identity/me/email` envoie un code par e-mail à la nouvelle
adresse, `POST /api/v1/identity/me/email/verify` la confirme (ADR-026). identity ajoute ses propres
limites par adresse et par compte.

Type de compte : `GET /api/v1/identity/me` et chaque session ouverte ou renouvelée rendent
`activeContext` (`type` : `individual` ou `business`, `organizationId`), contexte du jeton lu par
cleaning et billing. Une réponse d'identity sans contexte actif est une erreur interne : déployer
identity avant la gateway.

## Routes du Nettoyage (lot 2)

37 routes vers `cleaning` (`CLEANING_GRPC_URL`, `localhost:50053` par défaut), déclarées dans `src/domain/routing/cleaning-routes.ts` :

- `/api/v1/cleaning/services` et `/api/v1/cleaning/zones` (zones desservies actives) : public ; `/api/v1/cleaning/simulations` (public, 20 par minute et par IP) ;
- `/api/v1/cleaning/quote-requests…` et `/api/v1/cleaning/missions…` : connecté ; la demande de devis exige un profil complet (vérifié auprès d'identity par la gateway) et, comme l'acceptation, l'en-tête `Idempotency-Key` ;
- `/api/v1/admin/cleaning/…` : rôles `cleaning_supervisor`, `cleaning_agent` ou `cleaning_admin` selon la route (extension `x-ksp-roles`) et double authentification faite pendant la session (`x-ksp-mfa-max-age`, 12 heures).

Le détail (corps, réponses, erreurs) est dans le contrat OpenAPI, étiquettes « Nettoyage » et « Nettoyage (back-office) ».

Le **manifeste de routage** (`src/domain/routing/route-manifest.ts`) est la seule source des routes : le décorateur `@Route('<operationId>')` en tire chemin, méthode, exigence d'accès et limite. Un test (`test/openapi.contract.spec.ts`) vérifie qu'il correspond exactement au contrat OpenAPI, que chaque point d'entrée en vient, et que les réponses réelles (succès et erreurs) respectent les schémas du contrat.

## Fonctionnement

| Sujet             | Règle                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type de client    | Déduit, jamais déclaré : origine `CORS_BACKOFFICE_ORIGINS` → back-office ; origine `CORS_WEB_ORIGINS` → web ; aucune origine et `X-App-Version` → mobile. Sinon, les routes d'authentification répondent 400 `GATEWAY_CLIENT_UNKNOWN`.                                                                  |
| Jeton de renouv.  | Web : cookie `__Secure-ksp_rt`, back-office : `__Secure-ksp_admin_rt` (`HttpOnly`, `Secure`, `SameSite=Strict`, chemin `/api/v1/identity/token`), jamais dans le corps. Mobile : dans le corps. Cookie effacé à la déconnexion et sur un jeton refusé par identity.                                     |
| Jeton d'accès     | Vérifié localement (`AccessTokenVerifier` du kit : ES256, `at+jwt`, émetteur, destinataire, expiration, 30 s de tolérance). Clés d'identity en cache 10 minutes, rechargées aussitôt pour une clé inconnue (au plus toutes les 30 s). Identity injoignable : dernières clés gardées ; aucune clé : 503. |
| Contexte transmis | `x-correlation-id` (créé par la gateway, renvoyé dans `X-Correlation-Id`), `x-client-ip`, `x-user-agent`, utilisateur vérifié (`x-user-id`, `x-session-id`, rôles…) et jeton de service de la gateway (`authorization`).                                                                                |
| Appels gRPC       | `GrpcCaller` du kit : 3 s de délai, coupe-circuit par service, une nouvelle tentative pour les lectures (`GetMe`), jamais pour les écritures.                                                                                                                                                           |
| Erreurs           | `{ error: { code, message, details, correlationId } }`, statut selon la table gRPC → HTTP du kit. Pannes techniques : `IDENTITY_UNAVAILABLE` (503), `IDENTITY_TIMEOUT` (504), sans détail interne. 429 avec `Retry-After`.                                                                              |
| Limites d'appels  | Compteurs à fenêtre fixe **en mémoire** : valables pour une seule instance. Plusieurs répliques exigent un stockage partagé (Redis) derrière le port `RateLimiter`.                                                                                                                                     |
| Sécurité HTTP     | Corps JSON de 1 Mo au plus (413), champs inconnus refusés, CORS limité aux origines configurées avec cookies, HSTS, `nosniff`, `no-referrer`, `Cache-Control: no-store`, pas d'en-tête `X-Powered-By`. Cookies et jetons masqués dans les journaux.                                                     |

En production, la configuration refuse de démarrer sans `IDENTITY_JWKS_URL`, `IDENTITY_TOKEN_URL` et `SERVICE_CLIENT_SECRET`, `TRUST_PROXY`, origines HTTPS, ou avec `REFRESH_COOKIE_INSECURE=true`.

## Organisation

| Dossier               | Contenu                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `src/domain`          | Manifeste de routage et ses règles, exigences d'accès, type de client, limites, cookie     |
| `src/application`     | `AuthorizeRequestUseCase` (contrôles avant appel), cas d'usage identity, ports             |
| `src/infrastructure`  | Client gRPC d'identity, cache des clés publiques, limiteur en mémoire                      |
| `src/interfaces/http` | Contrôleurs, décorateur `@Route`, garde, contexte de requête, format d'erreur, chaîne HTTP |

Tests : unitaires dans `src`, bout en bout dans `test/gateway.http.spec.ts` (vraie gateway face à un serveur gRPC identity simulé à partir du contrôleur généré, qui vérifie le jeton de service), contrat dans `test/openapi.contract.spec.ts`.
