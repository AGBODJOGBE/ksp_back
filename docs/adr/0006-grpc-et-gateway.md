# ADR-006 — gRPC entre services ; REST et WebSocket uniquement via la gateway

**Statut** : Accepté

## Contexte

Les fronts ont besoin d'une API web stable ; les services ont besoin d'appels internes typés et rapides.

## Décision

- Appels internes en **gRPC**, contrats dans `contracts/proto/ksp/<service>/v1/`, paquet `ksp.<service>.v1`.
- Seule la `gateway` expose REST (`/api/v1/...`, OpenAPI) et WebSocket aux fronts.
- Chaque appel gRPC a un délai, des nouvelles tentatives limitées (seulement si l'appel est idempotent) et un coupe-circuit (`GrpcCaller`).

## Alternatives écartées

- **REST partout** : contrats moins stricts, pas de génération de code fiable.

## Conséquences

- Format d'erreur unique `{ error: { code, message, details, correlationId } }` et table de correspondance gRPC → HTTP dans le kit.
- Contrôle de compatibilité automatique des `.proto` en CI (`buf breaking`).
