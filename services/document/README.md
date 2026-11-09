# Service `document`

Cahier des charges : `docs/services/document/`. Contrat gRPC : `contracts/proto/ksp/document/v1/`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/document-service prisma:migrate   # crée les tables
pnpm --filter @ksp/document-service dev
```

- gRPC : `localhost:50057`
- Santé : `http://localhost:3107/health/live` et `/health/ready`
- Métriques : `http://localhost:3107/metrics`

## Organisation

| Dossier              | Contenu                                                    |
| -------------------- | ---------------------------------------------------------- |
| `src/domain`         | Règles métier, sans aucune dépendance technique            |
| `src/application`    | Un cas d'usage par classe                                  |
| `src/infrastructure` | Base de données, RabbitMQ, appels vers les autres services |
| `src/interfaces`     | Contrôleurs gRPC et consommateurs d'événements             |
