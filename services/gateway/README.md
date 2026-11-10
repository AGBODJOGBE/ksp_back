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
- Santé, sur le port interne `http://localhost:3100` (`INTERNAL_HTTP_PORT`, jamais exposé, ADR-051) : `/health/live` et `/health/ready` (prêt = clés publiques d'identity en cache ; 503 dès le `SIGTERM`) ; métriques : `/metrics`

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

Suppression du compte (ADR-036) : `POST /api/v1/identity/me/deletion` (`AccountService/RequestDeletion`,
délai de 6 secondes : identity interroge plusieurs services ; cookie de renouvellement effacé sur le
web) et `DELETE /api/v1/identity/me/deletion` (`AccountService/CancelDeletion`, nouveau jeton d'accès
complet). Pendant le délai, le jeton d'une nouvelle connexion porte le seul rôle
`account_deletion_pending` : la gateway le refuse sur toute route connectée
(`GATEWAY_ACCOUNT_DELETION_PENDING`, 403) sauf celles marquées `x-ksp-pending-deletion` dans le contrat
(`GET /me`, `DELETE /me/deletion`, `POST /logout`).

Type de compte : `GET /api/v1/identity/me` et chaque session ouverte ou renouvelée rendent
`activeContext` (`type` : `individual` ou `business`, `organizationId`), contexte du jeton lu par
cleaning et billing. Une réponse d'identity sans contexte actif est une erreur interne : déployer
identity avant la gateway.

## Routes des comptes entreprise (ADR-027)

| Route                                                                                           | Appel                                                           | Accès                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `POST /api/v1/identity/context`                                                                 | `AuthService/SwitchContext`                                     | connecté                                                  |
| `GET`, `POST /api/v1/identity/organizations`                                                    | `OrganizationService/ListMyOrganizations`, `CreateOrganization` | connecté                                                  |
| `GET /api/v1/identity/organizations/{id}`                                                       | `OrganizationService/GetMyOrganization`                         | connecté                                                  |
| `PUT /api/v1/identity/organizations/{id}/billing-email`                                         | `OrganizationService/ChangeOrganizationBillingEmail`            | connecté, 3 par utilisateur                               |
| `POST /api/v1/identity/organizations/{id}/billing-email/verify`                                 | `OrganizationService/ConfirmOrganizationBillingEmail`           | connecté, 10 par utilisateur                              |
| `GET /api/v1/admin/identity/organizations[/{id}]`                                               | `OrganizationAdminService/ListOrganizations`, `GetOrganization` | `super_admin`, `support_agent` + MFA                      |
| `POST /api/v1/admin/identity/organizations/{id}/validate`, `/reject`, `/suspend`, `/reactivate` | `OrganizationAdminService/…`                                    | `super_admin` + MFA                                       |
| `POST /api/v1/admin/identity/accounts/lookup` (numéro dans le corps, ADR-029)                   | `AccountAdminService/FindAccountByPhone`                        | `cleaning_admin`, `super_admin` + MFA, 20 par utilisateur |

`activeContext` porte aussi `organizationName` (raison sociale de l'organisation active, null pour
un particulier). Après `POST /api/v1/identity/context`, le front remplace son jeton d'accès par
celui de la réponse.

## Routes du Nettoyage (lot 2)

37 routes vers `cleaning` (`CLEANING_GRPC_URL`, `localhost:50053` par défaut), déclarées dans `src/domain/routing/cleaning-routes.ts` :

- `/api/v1/cleaning/services` et `/api/v1/cleaning/zones` (zones desservies actives) : public ; `/api/v1/cleaning/simulations` (public, 20 par minute et par IP) ;
- `/api/v1/cleaning/quote-requests…` et `/api/v1/cleaning/missions…` : connecté ; la demande de devis exige un profil complet (vérifié auprès d'identity par la gateway) et, comme l'acceptation, l'en-tête `Idempotency-Key` ;
- `/api/v1/admin/cleaning/…` : rôles `cleaning_supervisor`, `cleaning_agent` ou `cleaning_admin` selon la route (extension `x-ksp-roles`), `super_admin` partout avec la portée de `cleaning_admin`, et double authentification faite pendant la session (`x-ksp-mfa-max-age`, 12 heures). Le paiement manuel accepte un en-tête `Idempotency-Key` facultatif (`idempotencyKey: 'optional'` dans le manifeste).

Le détail (corps, réponses, erreurs) est dans le contrat OpenAPI, étiquettes « Nettoyage » et « Nettoyage (back-office) ».

## Routes des documents et de la signature (ADR-044)

7 routes vers `document` (`DOCUMENT_GRPC_URL`, `localhost:50058` par défaut), déclarées dans `src/domain/routing/document-routes.ts` :

| Route                                                  | Appel                                      | Accès                              |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------- |
| `GET /api/v1/document/documents/{id}`, `/download-url` | `DocumentService/GetMyDocument`, `…`       | connecté (titulaire ou signataire) |
| `POST /api/v1/document/signatures/{id}/otp`            | `DocumentService/SendSignatureCode`        | connecté, 3 par utilisateur        |
| `POST /api/v1/document/signatures/{id}/sign`           | `DocumentService/SignDocument`             | connecté, 10 par utilisateur       |
| `GET /api/v1/document/sign/{token}`                    | `DocumentSigningService/GetSigningSession` | public, 30 par IP                  |
| `POST /api/v1/document/sign/{token}/otp`               | `DocumentSigningService/SendSigningCode`   | public, 3 par IP                   |
| `POST /api/v1/document/sign/{token}/sign`              | `DocumentSigningService/SignWithLink`      | public, 10 par IP                  |

Le jeton d'un lien de signature est un secret : un jeton mal formé est refusé (404) sans appeler document, et le kit le remplace par `[masqué]` dans l'adresse et les paramètres journalisés de chaque requête. L'adresse IP et le navigateur (`x-client-ip`, `x-user-agent`) sont transmis à document, qui les inscrit dans la preuve de signature. Aucun identifiant de fichier n'est rendu : le PDF se lit par l'adresse de courte durée de `/download-url` (ou `download` du lien).

Le **manifeste de routage** (`src/domain/routing/route-manifest.ts`) est la seule source des routes : le décorateur `@Route('<operationId>')` en tire chemin, méthode, exigence d'accès et limite. Un test (`test/openapi.contract.spec.ts`) vérifie qu'il correspond exactement au contrat OpenAPI, que chaque point d'entrée en vient, et que les réponses réelles (succès et erreurs) respectent les schémas du contrat.

## Routes du centre de notifications (ADR-039)

9 routes vers `notification` (`NOTIFICATION_GRPC_URL`, `localhost:50052` par défaut), déclarées dans `src/domain/routing/notification-routes.ts` :

| Route                                                                               | Appel                                                                            | Accès                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/v1/notification/notifications` (`unread`, `limit`, `cursor`)              | `InAppNotificationService/ListMyNotifications`                                   | connecté                             |
| `GET /api/v1/notification/notifications/unread-count`                               | `InAppNotificationService/CountMyUnreadNotifications`                            | connecté                             |
| `POST /api/v1/notification/notifications/{id}/read`, `/read-all`                    | `InAppNotificationService/MarkNotificationRead`, `…AllRead`                      | connecté                             |
| `GET`, `PUT /api/v1/notification/preferences`                                       | `InAppNotificationService/Get`/`UpdateMyNotificationPreferences`                 | connecté                             |
| `GET /api/v1/admin/notification/deliveries[/{id}]`, `/admin/notification/templates` | `NotificationAdminService/ListDeliveries`, `GetDelivery`, `ListMessageTemplates` | `super_admin`, `support_agent` + MFA |

La gateway appelle `notification` avec son jeton de service : `notification` doit figurer dans les `audiences` de la gateway dans `SERVICE_CLIENTS` d'identity (ADR-022).

## Liens de paiement, reversements, portefeuille (ADR-040 à 042)

| Route                                                                                 | Appel gRPC                                            | Accès                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| `GET /api/v1/payment/links/{token}`                                                   | `PaymentLinkPublicService/GetPublicPaymentLink`       | public, 30 par minute et par IP            |
| `POST /api/v1/payment/links/{token}/pay` (`Idempotency-Key`)                          | `PaymentLinkPublicService/PayPaymentLink`             | public, 5 par minute et par IP             |
| `POST /api/v1/payment/links/{token}/simulate` (développement)                         | `PaymentLinkPublicService/SimulatePaymentLinkPayment` | public, fermée en production               |
| `GET /api/v1/admin/payment/payouts`, `POST …/{id}/confirm`, `…/{id}/fail`             | `PayoutAdminService/…`                                | `finance_officer`, `super_admin` + MFA     |
| `GET /api/v1/wallet/me`, `…/me/statement`, `…/me/payouts`                             | `WalletAccountService/…` (`WALLET_GRPC_URL`)          | connecté (compte ou organisation active)   |
| `GET /api/v1/admin/wallet/holders/{type}/{id}[/statement]`, `…/payouts`, `…/overview` | `WalletAdminService/…`                                | `finance_officer`, `super_admin` + MFA     |
| `POST /api/v1/wallet/me/top-ups` (`Idempotency-Key`, ADR-046)                         | `WalletAccountService/CreateTopUp`                    | connecté (`org_viewer` refusé par wallet)  |
| `POST /api/v1/admin/wallet/holders/{type}/{id}/credits` (`Idempotency-Key`)           | `WalletAdminService/CreditPrepaidWallet`              | `finance_officer`, `super_admin` + MFA     |
| `POST /api/v1/cleaning/missions/{id}/pay` (`Idempotency-Key`, ADR-046)                | `MissionService/PayMissionFromWallet`                 | connecté (client de la mission)            |
| `POST /api/v1/billing/invoices/{id}/pay` (`Idempotency-Key`, ADR-046)                 | `BillingService/PayMyInvoiceFromWallet`               | connecté (`org_viewer` refusé par billing) |

Un jeton de lien mal formé rend 404 `PAYMENT_LINK_NOT_FOUND` sans appel de payment (rien de plus
qu'un jeton inconnu). Aucune donnée personnelle du payeur sur les routes publiques.

## Fonctionnement

| Sujet             | Règle                                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type de client    | Déduit, jamais déclaré : origine `CORS_BACKOFFICE_ORIGINS` → back-office ; origine `CORS_WEB_ORIGINS` → web ; aucune origine et `X-App-Version` → mobile. Sinon, les routes d'authentification répondent 400 `GATEWAY_CLIENT_UNKNOWN`.                                                                  |
| Jeton de renouv.  | Web : cookie `__Secure-ksp_rt`, back-office : `__Secure-ksp_admin_rt` (`HttpOnly`, `Secure`, `SameSite=Strict`, chemin `/api/v1/identity/token`), jamais dans le corps. Mobile : dans le corps. Cookie effacé à la déconnexion et sur un jeton refusé par identity.                                     |
| Jeton d'accès     | Vérifié localement (`AccessTokenVerifier` du kit : ES256, `at+jwt`, émetteur, destinataire, expiration, 30 s de tolérance). Clés d'identity en cache 10 minutes, rechargées aussitôt pour une clé inconnue (au plus toutes les 30 s). Identity injoignable : dernières clés gardées ; aucune clé : 503. |
| Contexte transmis | `x-correlation-id` (créé par la gateway, renvoyé dans `X-Correlation-Id`), `x-client-ip`, `x-user-agent`, utilisateur vérifié (`x-user-id`, `x-session-id`, rôles…) et jeton de service de la gateway (`authorization`).                                                                                |
| Appels gRPC       | `GrpcCaller` du kit : 3 s de délai, coupe-circuit par service, une nouvelle tentative pour les lectures (`GetMe`), jamais pour les écritures.                                                                                                                                                           |
| Erreurs           | `{ error: { code, message, details, correlationId } }`, statut selon la table gRPC → HTTP du kit. Pannes techniques : `IDENTITY_UNAVAILABLE` (503), `IDENTITY_TIMEOUT` (504), sans détail interne. 429 avec `Retry-After`.                                                                              |
| Limites d'appels  | Compteurs à fenêtre fixe dans **Redis** (`REDIS_URL`, obligatoire en production) partagés par les répliques, repli en mémoire si Redis ne répond pas ; en mémoire sans `REDIS_URL` (développement). Au moins deux répliques en production (ADR-051).                                                    |
| Sécurité HTTP     | Corps JSON de 1 Mo au plus (413), champs inconnus refusés, CORS limité aux origines configurées avec cookies, HSTS, `nosniff`, `no-referrer`, `Cache-Control: no-store`, pas d'en-tête `X-Powered-By`. Cookies et jetons masqués dans les journaux.                                                     |

En production, la configuration refuse de démarrer sans `IDENTITY_JWKS_URL`, `IDENTITY_TOKEN_URL` et `SERVICE_CLIENT_SECRET`, `TRUST_PROXY`, origines HTTPS, ou avec `REFRESH_COOKIE_INSECURE=true`.

## Organisation

| Dossier               | Contenu                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `src/domain`          | Manifeste de routage et ses règles, exigences d'accès, type de client, limites, cookie     |
| `src/application`     | `AuthorizeRequestUseCase` (contrôles avant appel), cas d'usage identity, ports             |
| `src/infrastructure`  | Client gRPC d'identity, cache des clés publiques, limiteurs Redis et en mémoire            |
| `src/interfaces/http` | Contrôleurs, décorateur `@Route`, garde, contexte de requête, format d'erreur, chaîne HTTP |

Tests : unitaires dans `src`, bout en bout dans `test/gateway.http.spec.ts` (vraie gateway face à un serveur gRPC identity simulé à partir du contrôleur généré, qui vérifie le jeton de service), contrat dans `test/openapi.contract.spec.ts`.
