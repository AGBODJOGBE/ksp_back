# ADR-027 — Comptes entreprise : organisations validées par KSP, membres et contexte actif

**Statut** : Accepté (lot 2, décisions du responsable du 2026-10-27)

## Contexte

Le Nettoyage distingue le particulier (tout réglé à la fin) de l'entreprise (facture mensuelle, ADR-025). `cleaning` et `billing` lisent ce type dans le claim `ctx` du jeton d'accès : `personal` pour un particulier, l'identifiant d'une organisation pour une entreprise. La gateway expose déjà `activeContext` aux fronts. Mais identity n'avait aucune organisation : `ctx` valait toujours `personal`, et tous les clients étaient des particuliers.

Le cahier des charges Identité prévoit les organisations (UC-ID-12 à 16) : création, membres, changement de contexte. Le responsable a fixé le 2026-10-27 : fiche avec raison sociale, adresse, **IFU obligatoire**, RCCM facultatif et e-mail de facturation **vérifié par code** ; création par le client, **validation ou refus motivé par un admin KSP** avant tout usage ; pas de TVA.

## Décision

1. **Organisation** (table `organizations`) : raison sociale, adresse, IFU (13 chiffres, espaces ignorés ; seul le format est contrôlé, aucune règle de clé n'est inventée), RCCM facultatif (forme souple, en majuscules), e-mail de facturation. Aucun champ fiscal au-delà de l'IFU et du RCCM.
2. **Cycle de vie** : `pending_review` (demande du client) → `active` (validée) ou `rejected` (refusée avec motif, définitif ; le client peut refaire une demande) ; `active` ↔ `suspended` (motif obligatoire). Transitions conditionnelles en base : de deux décisions simultanées, une seule passe. Chaque décision écrit, dans la même transaction, l'événement (outbox) et une ligne du journal d'audit d'identity (`audit_log` : auteur, action, état de départ et d'arrivée, motif), sur le modèle de cleaning en attendant le service audit.
3. **Garde-fous de création** : un IFU n'appartient qu'à une organisation non refusée (index unique partiel) ; un compte a au plus 3 demandes en attente.
4. **Membres** (table `organization_members`) : le créateur devient `org_admin`. Le rôle est porté par l'appartenance, pas par `role_assignments` : une seule source pour « qui est membre de quoi ». Un membre retiré garde sa ligne (`removed_at`). L'invitation d'autres membres viendra plus tard (UC-ID-13, 14, 16).
5. **Contexte actif** : une session s'ouvre toujours dans le contexte personnel. `AuthService.SwitchContext` (route `POST /api/v1/identity/context`) active une organisation **validée** dont l'appelant est membre, l'enregistre dans `sessions.active_org_id` et réémet un **jeton d'accès** (`ctx` = organisation, rôles = `customer` + rôle du membre de portée `org`) ; le jeton de renouvellement ne change pas. `organizationId: null` ramène au contexte personnel. Le **renouvellement** relit l'organisation : il garde le contexte tant qu'elle est validée et l'utilisateur membre, sinon il revient au contexte personnel et efface `active_org_id`. Une session du back-office reste dans le contexte personnel (`IDENTITY_CONTEXT_FORBIDDEN`).
6. **Raison sociale dans `activeContext`** (`organizationName`, ajout) : renvoyée avec le jeton (SwitchContext, renouvellement) et dans le profil (`GetMe`, `UpdateMe`, `ConfirmEmail`, lue en base d'après le `ctx` de l'appelant). Elle n'est pas écrite dans le jeton.
7. **E-mail de facturation** : même mécanisme que l'e-mail du profil (ADR-026), mêmes règles de code et **mêmes limites d'envoi, partagées** (table `email_verifications`, colonne `organization_id`). Modèle `identity.organization_email_verification` (raison sociale citée). Réservé à un `org_admin`, organisation en attente ou validée. Une même adresse peut servir à plusieurs organisations (cabinet comptable). Sans adresse confirmée, la facture reste visible dans l'espace KSP.
8. **Back-office** (`OrganizationAdminService`, routes `/api/v1/admin/identity/organizations`) : consultation par `super_admin` et `support_agent`, décisions par `super_admin` seul ; double authentification exigée, revérifiée par identity.
9. **Événements** : `identity.organization.created` (reçoit la raison sociale, champ facultatif ajouté), `identity.member.added`, et quatre nouveaux : `identity.organization.validated`, `.rejected`, `.suspended`, `.reactivated`. notification prévient l'équipe KSP d'une demande (`NOTIFICATION_ACCOUNTS_TEAM_USER_IDS`) et le demandeur de la validation ou du refus (motif).

## Alternatives écartées

- **Rôles d'organisation dans `role_assignments`** : deux tables à garder cohérentes (appartenance et rôle), et un catalogue de rôles `org_*` à écrire par migration sans écran pour les gérer.
- **Organisation utilisable dès sa création** : un client pourrait se déclarer entreprise (facture à 10 jours, pas de paiement à la fin) sans contrôle de l'IFU.
- **Contexte dans le seul jeton, sans `active_org_id`** : le renouvellement ne saurait pas quel contexte garder, l'utilisateur devrait le rechoisir toutes les 15 minutes.
- **Table séparée pour les codes de l'e-mail de facturation** : limites d'envoi non partagées avec l'e-mail du profil (une boîte pourrait recevoir deux fois plus de codes).

## Conséquences

- Un jeton émis avant une suspension reste valable jusqu'à son expiration (15 minutes au plus) ; le renouvellement suivant ramène au contexte personnel.
- `cleaning` liste les demandes et missions du client par compte (`customerId`), pas par organisation : tant qu'une organisation n'a qu'un membre, c'est sans effet ; à l'arrivée des invitations, les listes devront filtrer par organisation dans le contexte entreprise.
- `billing` envoie les factures au compte client ; l'envoi à l'e-mail de facturation et la raison sociale ou l'IFU sur la facture demanderont une lecture de l'organisation (RPC interne à ajouter à `IdentityService`).
- La suspension et la réactivation ne sont annoncées par aucun message (motif visible dans l'espace KSP).
