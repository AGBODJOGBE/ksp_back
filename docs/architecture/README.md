# Vue d'ensemble technique

Le backend KSP est un ensemble de services indépendants. Chacun possède sa base, publie ses faits sur RabbitMQ et répond aux questions des autres en gRPC. Seule la `gateway` est exposée aux fronts.

```
Fronts (Next.js, application livreur)
        │  REST /api/v1 + WebSocket
        ▼
Cloudflare → Traefik (k3s) → gateway
                               │ gRPC (+ jeton de service, contexte utilisateur)
        ┌──────────────┬───────┴──────┬──────────────┐
     identity     notification      payment   ...  recovery
        │              │               │              │
   PostgreSQL     PostgreSQL      PostgreSQL     PostgreSQL     (une base par service)
        └──────── outbox ─────► RabbitMQ « ksp.events » ◄──── inbox ────────┘
```

## Solutions partenaires

Des solutions externes (livraison, puis impression et nettoyage) se branchent à KSP sans jamais entrer dans le système interne (ADR-019) :

```
Partenaires (ForYou, autres) — n'importe quel langage, n'importe quelle base
        │ REST /partner/v1 (identifiants machine)      ▲ webhooks signés
        ▼                                              │
     gateway ── gRPC ──► delivery ── port fournisseur ─┘
                            │
                            └─ événements delivery.job.* ──► order, wallet, notification
```

- Chaque capacité a un contrat standard écrit par KSP (`contracts/partner/`), avec ses tests de conformité.
- Au panier, `delivery` demande un devis à chaque partenaire qui couvre la zone ; chaque partenaire fixe ses prix.
- Le client paie d'avance le panier et la livraison ; `wallet` reverse leur part au partenaire et au commerçant après la livraison, moins les commissions KSP.

## Ce que fournit le kit `@ksp/platform`

| Besoin                                                    | Élément du kit                                                                                                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Démarrer un service (HTTP technique + gRPC, arrêt propre) | `bootstrapService`, `PlatformModule.forRoot`                                                                                                                                         |
| Configuration validée au démarrage                        | `baseServiceConfigSchema`, `loadConfig` (zod)                                                                                                                                        |
| Corrélation de bout en bout                               | `RequestContext` (AsyncLocalStorage), `runWithContext`, métadonnées `x-correlation-id`, `x-user-*`                                                                                   |
| Erreurs communes                                          | `AppError` (`invalid`, `notFound`, `conflict`…), conversion gRPC ↔ HTTP, filtre global                                                                                               |
| Appels gRPC sortants                                      | `GrpcCaller` : délai, nouvelles tentatives si idempotent, coupe-circuit, propagation du contexte et du jeton                                                                         |
| Authentification entre services                           | `ServiceTokenVerifier` (ES256, audience = service appelé), `GrpcContextInterceptor` ; `ServiceTokenClient` obtient et garde en cache les jetons (`/oauth/token` d'identity, ADR-022) |
| Jetons d'accès (gateway)                                  | `AccessTokenVerifier` (RFC 9068, contrat `contracts/tokens`, clés publiques d'identity sur `/.well-known/jwks.json`, ADR-020)                                                        |
| Droits de l'utilisateur                                   | `requireUser`, `requireRole`, `requireRecentMfa`                                                                                                                                     |
| Événements                                                | `createEnvelope`, `appendToOutbox`, `SqlOutboxStore`, `OutboxRelay`, `SqlInboxStore`, `RabbitMqPublisher`, `RabbitMqConsumer`                                                        |
| Santé et métriques                                        | `/health/live`, `/health/ready` (`ReadinessRegistry`), `/metrics` (Prometheus)                                                                                                       |
| Journaux                                                  | pino structuré, champs sensibles masqués (`REDACTED_PATHS`), `correlationId` sur chaque ligne                                                                                        |
| Traces                                                    | OpenTelemetry (activé si `OTEL_EXPORTER_OTLP_ENDPOINT` est défini)                                                                                                                   |

## Publier un événement

Dans la transaction qui modifie la donnée métier :

```ts
await prisma.$transaction(async (tx) => {
  await tx.user.create({ data: user });
  await appendToOutbox(
    tx,
    createEnvelope('identity.user.registered', { userId, method: 'phone' }, { producer: 'identity' }),
  );
});
```

Le relais (`OutboxRelayService`, présent dans chaque service généré) publie ensuite les événements dans l'ordre. Si RabbitMQ est indisponible, ils restent dans la table `outbox` et partent au retour du broker. Plusieurs instances du service peuvent tourner : `FOR UPDATE SKIP LOCKED` garantit qu'un événement n'est pris que par un relais.

## Consommer un événement

```ts
// RabbitMqConsumer configuré avec { consumer: 'notification' }
consumer.subscribe('identity.user.registered', async (envelope) => {
  await inbox.runOnce(envelope.eventId, 'notification', async (tx) => {
    // effet métier, dans la même transaction que l'enregistrement de l'événement
  });
});
```

- Un événement déjà traité est ignoré (`duplicate`).
- En cas d'échec, l'événement repasse par la file `.retry` (délai), puis part en `.dlq` après le nombre maximal de tentatives.

## Appeler un autre service

```ts
// GrpcCaller configuré avec { target: 'identity', serviceTokenProvider }
const user = await this.identityCaller.call(
  'getUser',
  (metadata) => this.identity.getUser({ userId }, metadata),
  {
    idempotent: true,
  },
);
```

Erreur métier du service appelé : transmise telle quelle (même `code`). Service indisponible : coupe-circuit ouvert puis erreur `IDENTITY_UNAVAILABLE`.

## Contexte transmis à chaque appel gRPC

| Métadonnée                                        | Contenu                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `authorization`                                   | `Bearer <jeton de service>` signé par `identity`                 |
| `x-correlation-id` · `x-causation-id`             | Identifiants de corrélation                                      |
| `x-user-id` · `x-session-id` · `x-active-context` | Utilisateur, session, contexte actif (personnel ou organisation) |
| `x-user-roles`                                    | Rôles et portées (JSON)                                          |
| `x-user-mfa` · `x-auth-time`                      | Double authentification et heure de connexion                    |

## Format d'erreur

```json
{
  "error": {
    "code": "IDENTITY_OTP_EXPIRED",
    "message": "Le code a expiré.",
    "details": {},
    "correlationId": "..."
  }
}
```

| Erreur (`AppError`) | gRPC                                       | HTTP (gateway) |
| ------------------- | ------------------------------------------ | -------------- |
| `invalid`           | INVALID_ARGUMENT                           | 400            |
| `unauthenticated`   | UNAUTHENTICATED                            | 401            |
| `forbidden`         | PERMISSION_DENIED                          | 403            |
| `notFound`          | NOT_FOUND                                  | 404            |
| `conflict`          | ALREADY_EXISTS                             | 409            |
| `precondition`      | FAILED_PRECONDITION                        | 422            |
| `rateLimited`       | RESOURCE_EXHAUSTED                         | 429            |
| `notImplemented`    | UNIMPLEMENTED                              | 501            |
| `unavailable`       | UNAVAILABLE                                | 503            |
| erreur inattendue   | INTERNAL (`INTERNAL_ERROR`, détail masqué) | 500            |
