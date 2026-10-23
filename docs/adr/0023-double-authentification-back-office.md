# ADR-023 — Double authentification du back-office : application d'authentification et codes de récupération

**Statut** : Accepté (décision du 2026-10-17)

## Contexte

Le cahier des charges Identité (UC-ID-09) rend la double authentification obligatoire pour tout compte qui a un rôle du back-office, avec l'application d'authentification (TOTP) comme méthode principale et **un code SMS comme secours**. Il prévoit aussi des codes de récupération remis à l'activation.

Or un compte interne se connecte déjà par téléphone : la première étape est un code reçu par WhatsApp ou SMS (UC-ID-01). Un secours par SMS ferait reposer les deux étapes sur le même téléphone et la même carte SIM : un vol du téléphone ou une substitution de carte SIM suffirait à ouvrir le back-office. Ce serait une seule preuve présentée deux fois.

## Décision

**Écart au cahier des charges** : pas de secours par SMS pour les comptes internes.

1. **Connexion d'un compte interne** : téléphone + code (UC-ID-01), puis code de l'application d'authentification. La première étape renvoie une étape de double authentification (`mfa_required`) au lieu d'une session ; un compte sans rôle du back-office est refusé (`IDENTITY_BACKOFFICE_FORBIDDEN`) et aucun compte n'est créé depuis le back-office.
2. **Configuration forcée à la première connexion** (`enrollmentRequired`) : `EnrollTotp` crée le secret, `ConfirmTotp` l'active par un premier code. Aucun accès au back-office avant.
3. **Secours = 10 codes de récupération** à usage unique, remis une seule fois à l'activation. Jamais de SMS (`MFA_METHOD_SMS` refusé par `VerifyMfa`).
4. **Jeton de double authentification** : 32 octets aléatoires, valable 5 minutes, à usage unique, lié au compte et au type de client, conservé en empreinte SHA-256. 5 codes faux l'annulent ; il faut alors recommencer la connexion.
5. **TOTP** (RFC 6238) : SHA-1, 6 chiffres, 30 secondes, émetteur « KSP », compte = numéro de téléphone. Tolérance d'un pas de part et d'autre ; un code d'un pas égal ou antérieur au dernier accepté est refusé (pas de rejeu, même en parallèle : contrôle atomique en base).
6. **Secrets stockés** : secret TOTP chiffré en AES-256-GCM avec `IDENTITY_MFA_ENCRYPTION_KEY` (coffre à secrets, obligatoire en production, clé temporaire ailleurs), identifiant du compte en données associées ; codes de récupération conservés en empreinte HMAC-SHA256 liée au compte.
7. **Session du back-office** : 12 heures sans prolongation, fermée après 30 minutes sans renouvellement, 2 sessions au plus (comptées à part de celles des sites et applications). Le jeton d'accès porte `client_id = backoffice`, `mfa = true`, `amr = ["otp", "mfa"]`, `auth_time` = heure de la double authentification, et les rôles attribués, relus à chaque renouvellement : un rôle retiré ferme la session au renouvellement suivant.

Le transport côté gateway : routes `/api/v1/identity/mfa/…` avec le jeton dans le corps (accès `mfa_token`, vérifié par identity), type de client déduit de l'origine, cookie `__Secure-ksp_admin_rt` posé à la fin.

## Alternatives écartées

- **Secours par SMS** (cahier des charges) : même téléphone que la première étape (voir le contexte).
- **Réinitialisation de la double authentification par le support** comme seul secours : bloque un agent hors des heures ouvrées ; elle viendra en plus, avec l'administration des comptes internes.
- **Clés de sécurité (WebAuthn)** : plus sûres, mais coût d'équipement et de prise en main trop élevé au lancement ; ajout possible plus tard sans rupture (nouvelle valeur de `MfaMethod`).

## Conséquences

- Perdre le téléphone **et** les codes de récupération bloque l'accès : la réinitialisation par un administrateur (UC-ID-18, UC-ID-19) reste à construire avec l'administration des comptes internes.
- Le premier administrateur est créé par le script `pnpm --filter @ksp/identity-service roles:grant <+229…> <rôle>`, après une première connexion par téléphone sur le site ou l'application.
- Le catalogue initial des rôles du back-office est écrit par la migration `0004_roles_and_mfa` ; les services métier déclareront ensuite leurs propres catalogues (`RegisterCatalog`).
- La clé de chiffrement ne peut pas changer sans rechiffrer les secrets : le format stocké commence par `v1` pour permettre une rotation plus tard.
