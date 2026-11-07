# ADR-038 — Administration des comptes et des rôles au back-office : périmètre par métier, jamais sans super administrateur

**Statut** : Proposé (lot 2 ; UC-ID-18 à 20 ; décisions prises sur délégation du responsable)

## Contexte

Donner un rôle du back-office (superviseur, agent, finance, admin…) imposait jusqu'ici le script `roles:grant` ou une écriture en base. L'ADR-023 a laissé à « l'administration des comptes internes » la réinitialisation de la double authentification (téléphone perdu), et le contrat prévoyait déjà la suspension d'un compte (`identity.user.suspended` et `.reactivated`, état `suspended` refusé à la connexion et au renouvellement). Il manquait l'écran et ses règles : qui peut donner quoi, comment ne jamais bloquer le système, comment tout tracer.

## Décision

1. **Service gRPC `AccountAdminService`, par ajout** : `SearchAccounts`, `GetAccount`, `ListAssignableRoles`, `GrantAccountRole`, `RevokeAccountRole`, `SuspendAccount`, `ReactivateAccount`, `ResetAccountMfa`, réservés à la gateway (utilisateur dans les métadonnées), comme `OrganizationAdminService`. `IdentityService.GrantRole` et `RevokeRole` restent réservés aux appels de service à service (jeton de service) et ne sont pas encore livrés : une action d'une personne passe toujours par la gateway avec son jeton. Chaque écriture renvoie la fiche complète du compte (`AccountDetail`), y compris les actions permises à l'appelant (`actions`, `revocable`) : le back-office n'a aucune règle de droits à recopier.
2. **Routes REST** sous `/api/v1/admin/identity/` : `accounts/search` (POST : un numéro ne voyage jamais dans l'adresse, journalisée), `accounts/{id}`, `roles`, `accounts/{id}/roles`, `accounts/{id}/roles/revoke`, `accounts/{id}/suspend`, `/reactivate`, `/mfa/reset`. Double authentification faite pendant la session du back-office (12 heures au plus), comme toutes les routes du back-office. Recherche limitée par la catégorie `account_lookup` (20 par minute et par utilisateur) contre l'énumération.
3. **Périmètre** :
   - `super_admin` : tout rôle de portée globale ou métier (y compris `super_admin`), sur tout compte ; seul à suspendre, réactiver et réinitialiser la double authentification ; voit le numéro complet.
   - **administrateur d'un métier** (`cleaning_admin`, `recovery_admin` ; table `DOMAIN_ADMIN_ROLES`) : attribue et retire les rôles de son métier, **jamais le sien** (personne ne crée un pair) ni ceux d'un autre métier ; ne voit que son équipe (comptes qui ont un rôle actif de son métier), ou un compte dont il donne le numéro complet (même règle que `FindAccountByPhone`, ADR-029) ; numéro affiché masqué. Raison : le responsable du Nettoyage rattache déjà ses agents (ADR-029) ; sans ce droit, chaque nouvel agent attendrait la direction pour accéder au back-office. Le risque est borné : il ne peut ouvrir que les écrans de son propre métier.
   - `support_agent` et les autres rôles : aucun accès (le module « Clients et comptes » reste celui du support).
4. **Jamais sans super administrateur actif** : le retrait du rôle `super_admin` et la suspension d'un compte qui l'a sont refusés (`IDENTITY_LAST_SUPER_ADMIN`) si aucun autre compte **actif** ne le garde. Le contrôle se fait dans la transaction, sous un verrou de la ligne `super_admin` du catalogue (`SELECT … FOR UPDATE`) : deux super administrateurs qui se retirent l'un l'autre en même temps passent l'un après l'autre, et le second est refusé.
5. **Pas d'action sur soi-même** pour la suspension et la réinitialisation de la double authentification (`IDENTITY_SELF_ACTION_FORBIDDEN`) : elles se demandent à un autre super administrateur. Retirer un de ses propres rôles reste permis (règle 4 comprise).
6. **Motif obligatoire** pour chaque écriture (une ligne, 500 caractères au plus). Il est gardé sur l'attribution (`grant_reason`, `revoke_reason`, `revoked_by`) et sur le compte suspendu (`suspended_at`, `suspended_by`, `suspension_reason`, effacés à la réactivation), et écrit dans le **journal d'audit d'identity** (`audit_log`, entité `user` : `user.role_granted`, `user.role_revoked`, `user.suspended`, `user.reactivated`, `user.mfa_reset`) dans la transaction de l'action. Événements existants publiés par l'outbox : `identity.role.granted`, `identity.role.revoked` (avec le motif), `identity.user.suspended`, `identity.user.reactivated`. Migration `0009_account_administration`, colonnes facultatives seulement.
7. **Effets** :
   - attribution : compte actif seulement (`IDENTITY_ACCOUNT_NOT_ACTIVE`) ; portée par défaut du rôle (globale, ou le métier qui le déclare) ; un rôle de portée organisation ou personnelle ne s'attribue pas ici (`IDENTITY_ROLE_SCOPE_INVALID`) ; une attribution active identique est rendue sans écriture. Le rôle entre dans le jeton au renouvellement suivant ; un compte qui n'avait pas de double authentification la configure à sa prochaine connexion au back-office (règle de l'ADR-023, inchangée) ;
   - retrait : effet au renouvellement suivant (15 minutes au plus), une session du back-office sans rôle restant est alors fermée (ADR-023) ;
   - suspension : toutes les sessions sont fermées tout de suite ; un jeton d'accès déjà émis expire seul (15 minutes au plus) ;
   - réinitialisation de la double authentification : application et codes de récupération effacés, sessions du back-office et étapes de connexion en cours fermées ; la prochaine connexion impose une nouvelle configuration (`enrollmentRequired`). Sans rien à effacer : `IDENTITY_MFA_NOT_ENROLLED`.

## Alternatives écartées

- **Brancher le back-office sur `IdentityService.GrantRole` / `RevokeRole`** : ces méthodes servent les services entre eux (jeton de service, catalogue déclaré par chaque service) ; y mêler les droits d'une personne aurait mélangé deux modèles d'appelants.
- **Réserver tout à `super_admin`** : plus simple, mais la direction deviendrait le passage obligé de chaque nouvel agent de terrain.
- **Administrateur de métier qui voit tous les comptes par nom** : il aurait parcouru tous les clients KSP ; la recherche par numéro complet suffit pour rattacher une personne connue.
- **Interdire tout retrait de son propre rôle** : inutilement rigide ; seul le cas « dernier super administrateur » est dangereux et il est couvert pour tous.

## Conséquences

- Le script `roles:grant` ne sert plus qu'à l'amorçage du premier super administrateur (attribution sans auteur ni motif, `grantedBy = system`).
- Un nouveau métier qui veut son administrateur l'ajoute à `DOMAIN_ADMIN_ROLES` et au manifeste de la gateway.
- La recherche par nom utilise `ILIKE` sans index dédié : suffisant au volume actuel ; un index trigramme viendra si la table des comptes grossit.
- La réinitialisation de la double authentification n'avertit pas encore le titulaire (aucun modèle de message) : à ajouter avec le cahier des charges notification.
