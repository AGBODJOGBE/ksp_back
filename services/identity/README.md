# Service identity

Cahier des charges : `docs/services/identity/`. Contrat gRPC : `contracts/proto/ksp/identity/v1/`.

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/identity-service prisma:migrate   # crée les tables
pnpm --filter @ksp/identity-service dev
```

- gRPC : `localhost:50051`
- Santé : `http://localhost:3101/health/live` et `/health/ready`
- Métriques : `http://localhost:3101/metrics`

## Organisation

| Dossier              | Contenu                                                    |
| -------------------- | ---------------------------------------------------------- |
| `src/domain`         | Règles métier, sans aucune dépendance technique            |
| `src/application`    | Un cas d'usage par classe                                  |
| `src/infrastructure` | Base de données, RabbitMQ, appels vers les autres services |
| `src/interfaces`     | Contrôleurs gRPC et consommateurs d'événements             |
| `src/cli`            | Commandes d'exploitation, compilées avec le service        |

## Premier compte du back-office

Aucun écran d'administration n'existe encore : le premier rôle s'attribue en ligne de commande
(ADR-023). Le compte doit exister (une connexion par téléphone sur le site ou l'application).

```bash
pnpm --filter @ksp/identity-service build
pnpm --filter @ksp/identity-service roles:grant +2290197000045 super_admin
```

Rôles du back-office (migration `0004_roles_and_mfa`) : `super_admin`, `support_agent`,
`finance_officer`, `cleaning_admin`, `cleaning_supervisor`, `cleaning_agent`, `recovery_admin`,
`recovery_agent`. À la connexion suivante au back-office, l'application d'authentification est
configurée, puis exigée à chaque connexion.
