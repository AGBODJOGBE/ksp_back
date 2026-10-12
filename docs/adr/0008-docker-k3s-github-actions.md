# ADR-008 — Docker, k3s et GitHub Actions

**Statut** : Accepté

## Contexte

Il faut déployer 17 services de façon reproductible, à un coût maîtrisé.

## Décision

Une image Docker par service, exécutée sur k3s ; intégration et livraison continues par GitHub Actions. Supervision par OpenTelemetry, Prometheus, Grafana, Loki et Sentry.

## Alternatives écartées

- **Kubernetes managé complet** : plus cher au démarrage.
- **Docker Compose en production** : pas de redémarrage, de mise à l'échelle ni de déploiement progressif fiables.

## Conséquences

- Préproduction déployée à chaque fusion sur `main`, production sur étiquette de version.
- La configuration du cluster vit dans `ksp-infra`.
