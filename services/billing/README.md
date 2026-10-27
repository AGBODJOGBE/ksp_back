# Service `billing`

Facturation mensuelle des contrats d'entreprise du Nettoyage (cahier des charges Nettoyage,
partie 10) : version minimale du lot 2. Contrat gRPC : `contracts/proto/ksp/billing/v1/` ;
événements : `contracts/events/billing/`.

## Règles

- **Contrats appris par événements** (une base par service) : `cleaning.booking.confirmed` d'une
  organisation crée le contrat (montant, durée, début `startsAt`) ; `cleaning.request.cancelled`
  y met fin ; `cleaning.contract.suspended` / `resumed` mettent la facturation en pause. Aucun
  appel vers cleaning : la facturation fonctionne même quand cleaning est arrêté.
- **Une facture par mois civil** (heure du Bénin, UTC+1), émise à la fin du mois : le 1er du
  mois suivant à 00:00, heure du Bénin (au premier passage de la tâche planifiée).
- **Prorata des jours** : montant mensuel (`total / durée`) × jours facturables / jours du mois,
  arrondi à l'entier de FCFA. Le premier et le dernier mois partiels sont proratisés ; les jours
  de suspension sont déduits de la même façon. Le dernier mois absorbe l'écart d'arrondi : hors
  suspension, la somme des factures vaut exactement le total. Un contrat annulé est facturé
  jusqu'au jour de l'annulation (exclu), sans absorption. Un mois entièrement suspendu n'est pas
  facturé.
- **En-tête des factures d'organisation** (ADR-028) : raison sociale, adresse, IFU et RCCM lus
  dans identity (`GetOrganizationsByIds`, jeton de service, délai, nouvelle tentative et
  coupe-circuit du kit) au moment de l'émission, et copiés dans la facture : une modification
  ultérieure de la fiche ne la change pas. Pas de TVA. Aucune facture n'est émise sans en-tête :
  identity indisponible → aucune émission, reprise au passage suivant (le passage en impayée
  continue) ; organisation introuvable → contrat reporté et journalisé. Les factures émises
  avant cet en-tête n'en ont pas (`organization` nul).
- **Numérotation** `FAC-<année>-<000001>`, continue par année (compteur dans la transaction).
- **Statuts** : `pending_payment` jusqu'à l'échéance (émission + délai réglable, 10 jours),
  puis `overdue` ; `paid` quand les paiements atteignent le total ; `cancelled` réservé.
- **Tâche planifiée interne** (`BILLING_SCHEDULER_INTERVAL_MS`, 15 minutes) : émission puis
  passage en impayée, idempotents (une facture par contrat et par mois, transitions
  conditionnelles).
- **Événements publiés** (outbox) : `billing.invoice.issued`, `billing.invoice.overdue`,
  `billing.invoice.paid` ; consommés par cleaning (avertissement, suspension, déblocage) et
  notification (espace client, e-mail).

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/billing-service prisma:migrate   # crée les tables
pnpm --filter @ksp/billing-service dev
```

- gRPC : `localhost:50054`
- Santé : `http://localhost:3104/health/live` et `/health/ready`
- Métriques : `http://localhost:3104/metrics`
- identity : `IDENTITY_GRPC_URL` (`localhost:50051`) ; jeton de service (`IDENTITY_TOKEN_URL`,
  `SERVICE_CLIENT_SECRET`) obligatoire en production. Entrée `SERVICE_CLIENTS` d'identity :
  `billing` avec l'audience `identity` (`keys:service-client billing identity`).

## Organisation

| Dossier              | Contenu                                                    |
| -------------------- | ---------------------------------------------------------- |
| `src/domain`         | Règles métier, sans aucune dépendance technique            |
| `src/application`    | Un cas d'usage par classe                                  |
| `src/infrastructure` | Base de données, RabbitMQ, appels vers les autres services |
| `src/interfaces`     | Contrôleurs gRPC et consommateurs d'événements             |
