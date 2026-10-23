# Service `__name__`

Cahier des charges : `docs/services/__name__/`. Contrat gRPC : `contracts/proto/ksp/__proto_name__/v1/`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/__name__-service prisma:migrate   # crée les tables
pnpm --filter @ksp/__name__-service dev
```

- gRPC : `localhost:__GRPC_PORT__`
- Santé : `http://localhost:__HTTP_PORT__/health/live` et `/health/ready`
- Métriques : `http://localhost:__HTTP_PORT__/metrics`

## Organisation

| Dossier              | Contenu                                                    |
| -------------------- | ---------------------------------------------------------- |
| `src/domain`         | Règles métier, sans aucune dépendance technique            |
| `src/application`    | Un cas d'usage par classe                                  |
| `src/infrastructure` | Base de données, RabbitMQ, appels vers les autres services |
| `src/interfaces`     | Contrôleurs gRPC et consommateurs d'événements             |
