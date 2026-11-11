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

| Règle                 | Fonctionnement                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Création              | `OrganizationService.CreateOrganization` (portail) : raison sociale, adresse, IFU (13 chiffres), RCCM facultatif. État `pending_review` ; le demandeur devient `org_admin`. Un IFU par organisation non refusée ; 3 demandes en attente au plus par compte.                                                                                                                                                                 |
| Validation            | `OrganizationAdminService` (back-office) : `super_admin` valide, refuse (motif), suspend (motif) ou réactive ; `super_admin` et `support_agent` consultent. Double authentification revérifiée ; chaque décision est écrite dans `audit_log`.                                                                                                                                                                               |
| Contexte actif        | `AuthService.SwitchContext` : organisation validée dont l'appelant est membre → `sessions.active_org_id` et nouveau jeton d'accès (`ctx` = organisation, rôle `org_admin` de portée `org`). Le renouvellement garde ce contexte, ou revient au personnel si l'organisation n'est plus validée ou le membre retiré. Back-office : contexte personnel seul.                                                                   |
| E-mail de facturation | `ChangeOrganizationBillingEmail` puis `ConfirmOrganizationBillingEmail` (`org_admin`, organisation en attente ou validée) : mêmes règles que l'e-mail du profil, limites d'envoi partagées, modèle `identity.organization_email_verification`.                                                                                                                                                                              |
| Événements            | `identity.organization.created`, `identity.member.added`, `identity.organization.validated`, `.rejected`, `.suspended`, `.reactivated` (outbox). La suspension et la réactivation portent `createdBy` (demandeur, prévenu par notification).                                                                                                                                                                                |
| Autres services       | `IdentityService.GetOrganizationsByIds` (jeton de service, 100 identifiants au plus) : raison sociale, adresse, IFU, RCCM, état et e-mail de facturation, ni membres ni décisions. Appelants : billing (en-tête des factures, sans l'e-mail), cleaning (raison sociale au back-office, sans l'e-mail, ADR-029) et notification (e-mail de facturation, toujours vérifié). Tout autre service → `IDENTITY_CALLER_FORBIDDEN`. |

## Suppression du compte (UC-ID-11, ADR-036)

- `AccountService.RequestDeletion` (`POST /api/v1/identity/me/deletion`) : refusée pour un compte
  interne, pour le seul administrateur d'une organisation non refusée, et dès qu'un service signale
  une obligation (`IDENTITY_DELETION_BLOCKED`, raisons lisibles) ou ne répond pas
  (`IDENTITY_DELETION_CHECK_UNAVAILABLE`, réessayer plus tard). Services interrogés en parallèle
  (`ksp.common.v1.ObligationService`) : `OBLIGATION_SERVICES` (par défaut cleaning, billing,
  payment), 1,5 s chacun. Acceptée : compte `deletion_pending` jusqu'à `deletion_scheduled_for`
  (`ACCOUNT_DELETION_DELAY_DAYS`, 30), toutes les sessions fermées,
  `identity.user.deletion_requested`.
- Pendant le délai, une connexion par code ouvre une **session restreinte** (rôle
  `account_deletion_pending`, sans `customer`) : la gateway n'accepte que `GetMe`, `CancelDeletion`
  et la déconnexion ; identity revérifie (`IDENTITY_ACCOUNT_DELETION_PENDING`). Pas de connexion au
  back-office.
- `AccountService.CancelDeletion` (`DELETE /api/v1/identity/me/deletion`) : compte de nouveau actif,
  `identity.user.deletion_cancelled`, nouveau jeton d'accès complet pour la même session.
- Tâche planifiée (`ACCOUNT_DELETION_INTERVAL_MS`, 15 minutes ; 0 la désactive) : comptes échus par
  lots de `ACCOUNT_DELETION_BATCH_SIZE` (50) ; mêmes contrôles ; obligation apparue → report
  enregistré (raisons dans `GetMe`) et signalé dans les journaux, nouveau contrôle après
  `ACCOUNT_DELETION_RECHECK_MINUTES` (60). Sinon anonymisation conditionnelle : nom, e-mail,
  numéros (libérés), sessions, double authentification, rôles, appartenances
  (`identity.member.removed`), puis `identity.user.deleted`, dans la même transaction.

## Recherche de compte au back-office (ADR-029)

- `AccountAdminService.FindAccountByPhone` (route `POST /api/v1/admin/identity/accounts/lookup`,
  numéro dans le corps) : identifiant, état, prénom, nom et numéro masqué, jamais l'e-mail ni le
  numéro complet. Rôles `cleaning_admin`, `super_admin`, double authentification revérifiée.
- `GetUsersByIds` sert aussi cleaning (noms affichés au back-office), sans téléphone ni e-mail.

## Confiance et comptes (ADR-050)

- **Essais des codes** (téléphone, e-mail, double authentification) : l'essai est pris en base, de façon atomique, avant de comparer le code ; des essais simultanés ne dépassent jamais le plafond.
- **Renouvellement entre onglets** : le successeur d'un jeton de renouvellement est dérivé de lui (HMAC, clé `OTP_HMAC_SECRET`) ; pendant `REFRESH_TOKEN_REUSE_GRACE_SECONDS` (10 s), l'ancien jeton rend le même successeur tant qu'il n'a pas servi. Au-delà, la réutilisation révoque la session (vol).
- **Appelants** : `AuthService`, `AccountService`, `AccountAdminService`, `OrganizationService` et `OrganizationAdminService` n'acceptent que la gateway (`@AllowedCallers('gateway')`) ; `IdentityService` reste ouvert aux services.
- **Administrateur de métier** : la fiche d'un compte hors de son équipe est introuvable ; écritures (rôles, suspension, réinitialisation) avec une double authentification de moins de 10 minutes.
- **Réinitialisation de la double authentification** : `identity.user.mfa_reset` prévient le titulaire ; reconfiguration ouverte `MFA_RESET_ENROLLMENT_SECONDS` (1 heure), puis `IDENTITY_MFA_ENROLLMENT_EXPIRED`.
- **Production** : `OTP_HMAC_SECRET` et `IDENTITY_MFA_ENCRYPTION_KEY` du `.env.example` refusés ; le portefeuille (`wallet`) est interrogé avant une suppression de compte.
- **Annuaire** : `GetOrganizationsByIds` rend à notification les administrateurs actuels (`admin_user_ids`), destinataires des factures de l'organisation.
