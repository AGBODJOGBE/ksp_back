# Service cleaning

Nettoyage & assainissement (lot 2) : simulateur public, demandes de devis, devis, missions et passages, catalogue et grille tarifaire, agents et équipes. Contrat gRPC : `contracts/proto/ksp/cleaning/v1/cleaning.proto` (avec `ksp.common.v1.ObligationService`). Événements : `contracts/events/cleaning/`. Routes REST : contrat OpenAPI, étiquettes « Nettoyage ».

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/cleaning-service prisma:deploy   # crée les tables (grille vide)
pnpm --filter @ksp/cleaning-service build && node --env-file=.env dist/main.js
```

- gRPC : `localhost:50053` (adresse attendue par la gateway, `CLEANING_GRPC_URL`)
- Santé : `http://localhost:3103/health/live` et `/health/ready`
- Métriques : `http://localhost:3103/metrics`

### Données de démonstration (développement uniquement)

La grille tarifaire est vide tant que l'équipe Nettoyage ne l'a pas remplie au back-office : le simulateur répond alors `priced: false`. Pour essayer le simulateur en local, `prisma/demo/demo-data.sql` charge cinq prestations avec des **prix inventés** ; le script refuse de s'exécuter sans l'accord explicite `ksp.demo=on` :

```bash
PGOPTIONS='-c ksp.demo=on' psql postgresql://cleaning:cleaning@localhost:5432/cleaning \
  -f services/cleaning/prisma/demo/demo-data.sql
```

## Règles (cahier des charges, parties 4 et 9)

| Sujet      | Fonctionnement                                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simulateur | `max(minimum, (quantité × prix unitaire + options) × coefficient de commune)` ; fourchette −10 % / +15 % arrondie à 500 FCFA ; entiers XOF. Rien n'est enregistré.                                                            |
| Grille     | Versionnée : chaque enregistrement crée une version datée avec son auteur ; un devis envoyé garde son prix.                                                                                                                   |
| Réglages   | Validité des devis (15 j), délai minimum (48 h), annulation sans frais (24 h), visite au-delà de 300 m², 5 demandes ouvertes, acompte 30 % : modifiables au back-office.                                                      |
| Demande    | reçue → visite planifiée → devis envoyé → acceptée / refusée / expirée / annulée, ou refusée par KSP. Visite obligatoire pour une entreprise (contexte d'organisation actif) ou au-delà du seuil.                             |
| Mission    | Un passage pour une prestation ponctuelle, plusieurs pour un contrat récurrent (passages par semaine ou par mois, sur N mois) ; chaque passage a ses agents, sa liste de contrôle et ses références de photos (service file). |
| Conflits   | Un agent ne peut être affecté à deux passages qui se chevauchent, ni pendant une indisponibilité (`CLEANING_TEAM_UNAVAILABLE`) ; agents verrouillés pendant la planification.                                                 |
| Paiement   | Option choisie à l'acceptation (acompte ou totalité, avant ou après, espèces ou Mobile Money) ; état dû / acompte reçu / payé ; paiements manuels cochés par le superviseur ; paiement en ligne : port prévu (`payment`).     |
| Droits     | Client : ses demandes et missions (404 sinon) ; agent : les missions où il est affecté ; superviseur et admin : rôle et double authentification revérifiés par le service.                                                    |
| Traces     | Événements par l'outbox dans la transaction de l'état (identifiants seulement, jamais d'adresse) ; table `audit_log` pour les prix, devis, affectations et paiements.                                                         |

## Organisation

| Dossier              | Contenu                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| `src/domain`         | Simulateur, états et transitions, devis, récurrence, créneaux, paiement    |
| `src/application`    | Un cas d'usage par classe (UC-CL-01 à 12), ports, doublures en mémoire     |
| `src/infrastructure` | Dépôts Prisma, outbox, verrous de planification                            |
| `src/interfaces`     | Contrôleurs gRPC (catalogue, devis, missions, back-office, obligations)    |
| `test`               | Module, gRPC de bout en bout, intégration PostgreSQL (`TEST_DATABASE_URL`) |
