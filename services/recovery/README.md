# Service `recovery`

Cahier des charges : `docs/services/recovery/`. Contrat gRPC : `contracts/proto/ksp/recovery/v1/`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/recovery-service prisma:migrate   # crée les tables
pnpm --filter @ksp/recovery-service dev
```

- gRPC : `localhost:50060`
- Santé : `http://localhost:3110/health/live` et `/health/ready`
- Métriques : `http://localhost:3110/metrics`

## Organisation

| Dossier              | Contenu                                                    |
| -------------------- | ---------------------------------------------------------- |
| `src/domain`         | Règles métier, sans aucune dépendance technique            |
| `src/application`    | Un cas d'usage par classe                                  |
| `src/infrastructure` | Base de données, RabbitMQ, appels vers les autres services |
| `src/interfaces`     | Contrôleurs gRPC et consommateurs d'événements             |
