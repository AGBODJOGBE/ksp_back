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

## E-mail du profil (ADR-026)

L'utilisateur connecté déclare ou change son e-mail (`ChangeEmail`, route
`PUT /api/v1/identity/me/email`) ; un code lui est envoyé **par e-mail** (notification, modèle
`identity.email_verification`), qu'il saisit pour confirmer (`ConfirmEmail`, route
`POST /api/v1/identity/me/email/verify`).

| Règle            | Fonctionnement                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enregistrement   | L'adresse (en minuscules) n'entre dans `users.email` qu'à la confirmation, avec `email_verified_at`. L'ancienne adresse vérifiée reste en place jusque-là ; l'adresse en attente est `pendingEmail` du profil.  |
| Code             | Mêmes règles que les codes par téléphone : HMAC, 5 essais, mêmes limites d'envoi, appliquées par adresse **et** par compte. Validité : `EMAIL_OTP_TTL_SECONDS` (15 minutes).                                    |
| Dernière demande | Seule la dernière demande du compte (table `email_verifications`) peut être confirmée : un nouvel envoi annule le code précédent.                                                                               |
| Unicité          | Une adresse confirmée n'appartient qu'à un compte (index unique). Anti-énumération : ce n'est signalé (`IDENTITY_EMAIL_ALREADY_USED`) qu'après la saisie du bon code.                                           |
| Traces           | Les lignes de `email_verifications` sont gardées (adresse, adresse IP, essais, dates) ; événements `identity.otp.requested` (`purpose: email_verification`) et `identity.user.verified` (`verifiedVia: email`). |
| Autres services  | `GetUser` et `GetUsersByIds` rendent `email` et `email_verified` ; notification n'écrit qu'à une adresse vérifiée.                                                                                              |

## Type de compte : contexte actif

Le jeton d'accès porte le contexte actif de la session (claim `ctx`) : `personal` ou l'identifiant
d'une organisation. cleaning et billing en déduisent le type de client : particulier pour le
contexte personnel, entreprise pour une organisation (facture mensuelle, pas de choix du moyen de
paiement). identity expose la même lecture aux fronts dans `active_context` (`type` :
`individual` ou `business`, `organization_id`) : avec chaque session ouverte ou renouvelée (contexte
du jeton émis) et dans `GetMe`, `UpdateMe` et `ConfirmEmail` (contexte du jeton de l'appelant).

Une session s'ouvre dans le contexte personnel (`individual`) ; `SwitchContext` active une
organisation validée (`business`, avec `organization_name`), voir ci-dessous.

## Comptes entreprise (ADR-027)

| Règle                 | Fonctionnement                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Création              | `OrganizationService.CreateOrganization` (portail) : raison sociale, adresse, IFU (13 chiffres), RCCM facultatif. État `pending_review` ; le demandeur devient `org_admin`. Un IFU par organisation non refusée ; 3 demandes en attente au plus par compte.                                                                                               |
| Validation            | `OrganizationAdminService` (back-office) : `super_admin` valide, refuse (motif), suspend (motif) ou réactive ; `super_admin` et `support_agent` consultent. Double authentification revérifiée ; chaque décision est écrite dans `audit_log`.                                                                                                             |
| Contexte actif        | `AuthService.SwitchContext` : organisation validée dont l'appelant est membre → `sessions.active_org_id` et nouveau jeton d'accès (`ctx` = organisation, rôle `org_admin` de portée `org`). Le renouvellement garde ce contexte, ou revient au personnel si l'organisation n'est plus validée ou le membre retiré. Back-office : contexte personnel seul. |
| E-mail de facturation | `ChangeOrganizationBillingEmail` puis `ConfirmOrganizationBillingEmail` (`org_admin`, organisation en attente ou validée) : mêmes règles que l'e-mail du profil, limites d'envoi partagées, modèle `identity.organization_email_verification`.                                                                                                            |
| Événements            | `identity.organization.created`, `identity.member.added`, `identity.organization.validated`, `.rejected`, `.suspended`, `.reactivated` (outbox).                                                                                                                                                                                                          |
