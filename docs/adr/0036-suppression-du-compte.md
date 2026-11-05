# ADR-036 — Suppression du compte : gel de 30 jours, obligations vérifiées dans chaque service, anonymisation

**Statut** : Proposé (décision du responsable du 2026-11-05)

## Contexte

Le cahier des charges Identité prévoit la suppression du compte par son titulaire (UC-ID-11). Le contrat `identity.proto` l'annonçait (`RequestDeletion`, `CancelDeletion`), la base avait déjà les statuts `deletion_pending` et `deleted` et la colonne `deletion_requested_at`, et le contrat commun `ksp.common.v1.ObligationService` (« une seule réponse positive bloque la suppression ») existait, implémenté par `cleaning` seul. L'événement `identity.user.deleted` (« anonymisé après le délai de suppression ») est déjà écouté par `cleaning`, qui efface les positions des lieux (ADR-035).

Le responsable a fixé le 2026-11-05 : compte **gelé 30 jours** (délai réglable) et sessions fermées ; **annulation possible en se reconnectant** ; demande **refusée si une obligation est en cours** (une seule réponse positive bloque, raisons lisibles), service injoignable = refus (« réessayez plus tard ») ; mêmes contrôles **refaits avant l'anonymisation**, qui est alors **reportée et signalée** ; à l'échéance, **anonymisation** dans identity puis `identity.user.deleted` dans la même transaction, par une tâche périodique idempotente et par lots ; traitement sûr des membres d'une organisation.

## Décision

1. **Demande** (`AccountService.RequestDeletion`, `POST /api/v1/identity/me/deletion`, sans corps) : compte actif seulement. Dans l'ordre, refus :
   - compte interne (rôle donnant accès au back-office) → `IDENTITY_DELETION_INTERNAL_ACCOUNT` (422) : il passe par un administrateur KSP ;
   - seul administrateur d'une organisation **non refusée** (en attente, validée ou suspendue) → `IDENTITY_DELETION_LAST_ORG_ADMIN` (422, `details.organizations`). Un autre administrateur lui-même en cours de suppression ne compte pas ;
   - obligation signalée par un service → `IDENTITY_DELETION_BLOCKED` (422, `details.obligations` : service, nature, référence, explication) ;
   - service injoignable (panne, délai de 1,5 s dépassé, coupe-circuit, refus de l'appel) → `IDENTITY_DELETION_CHECK_UNAVAILABLE` (503, `details.services`) : jamais d'accord par défaut.

   Acceptée : en une transaction, `status = deletion_pending`, `deletion_requested_at`, **`deletion_scheduled_for`** = demande + délai (date fixée à la demande : changer le réglage ne déplace pas les demandes en cours), révocation de **toutes** les sessions (`account_deletion_requested`), événement `identity.user.deletion_requested`. La gateway efface le cookie de renouvellement du web. Rejouer la demande rend la même échéance (idempotent par l'état, d'où l'absence d'en-tête `Idempotency-Key`).

2. **Obligations interrogées** : liste en configuration (`OBLIGATION_SERVICES=cleaning=…,billing=…,payment=…`), appels en parallèle, sans nouvelle tentative, jeton de service d'identity. Chaque service n'accepte que l'appelant `identity` (`<SERVICE>_CALLER_FORBIDDEN`) :
   - `cleaning` : mission non terminée (`open_cleaning_mission`) ou demande de devis ouverte — reçue, visite planifiée, devis envoyé encore valide (`open_cleaning_request`, ajout) ;
   - `billing` (nouveau) : facture en attente de paiement ou impayée du compte (`unpaid_invoice`, numéro de facture) — y compris celle d'une organisation pour le compte qui a demandé la prestation (seules les entreprises sont facturées au mois aujourd'hui) ;
   - `payment` (nouveau) : paiement en attente (`pending_payment`) ou écart de montant pas encore traité par la finance (`payment_under_review`), en son nom ou pour une organisation : le payeur est la personne.
3. **Session restreinte pendant le délai** : la connexion par code d'un compte `deletion_pending` reste possible sur le web et le mobile, mais le jeton d'accès porte le seul rôle **`account_deletion_pending`** (sans `customer`), contexte personnel ; le renouvellement garde ce rôle. La gateway refuse ce jeton sur toute route connectée (`GATEWAY_ACCOUNT_DELETION_PENDING`, 403), sauf celles qui l'acceptent explicitement (extension `x-ksp-pending-deletion`) : `GET /me`, `DELETE /me/deletion`, `POST /logout`. identity revérifie (`IDENTITY_ACCOUNT_DELETION_PENDING` sur `UpdateMe`, `ChangeEmail`, `ConfirmEmail`, `SwitchContext`). La connexion au back-office d'un tel compte est refusée. Refus par défaut : une route ajoutée plus tard est fermée à la session restreinte sans rien faire.
4. **Annulation** (`AccountService.CancelDeletion`, `DELETE /api/v1/identity/me/deletion`) : depuis une session encore ouverte (donc postérieure à la demande, `IDENTITY_SESSION_REVOKED` sinon) ; le compte redevient `active`, les champs de suppression sont effacés, événement `identity.user.deletion_cancelled`, et la réponse porte un **jeton d'accès complet** pour la même session (le jeton de renouvellement ne change pas). Idempotente.
5. **Lecture** : `GetMe` rend `deletion` (demande, date prévue, raisons d'un report) ; `user.status` vaut `deletion_pending`.
6. **Anonymisation** (tâche `AccountDeletionSchedulerService`, toutes les 15 minutes, 50 comptes par passage) : pour chaque compte échu jamais contrôlé ou contrôlé il y a plus de 60 minutes, les contrôles 1 et 2 sont refaits. Obligation (ou dernier administrateur) → **report** : date du contrôle et raisons enregistrées (`deletion_checked_at`, `deletion_postponed_by`, visibles dans `GetMe`), avertissement dans les journaux (identifiant et nature, jamais de coordonnées). Service injoignable → report sans changer les raisons. Sinon, en une transaction conditionnelle (compte toujours `deletion_pending` et échu : une annulation de dernière minute ou un autre passage l'emporte) : nom, e-mail, langue remis à zéro, `status = deleted`, `anonymized_at` ; numéros supprimés (le numéro redevient libre : une nouvelle connexion crée un nouveau compte) avec les codes envoyés à ces numéros ; sessions et jetons de renouvellement, double authentification, codes de l'e-mail du profil supprimés ; historique des connexions gardé sans IP ni appareil ; rôles retirés ; appartenances aux organisations retirées (`identity.member.removed`, `removedBy` = le compte) ; `identity.user.deleted`.
7. **Réglages** (configuration d'identity, qui n'a pas de réglages au back-office) : `ACCOUNT_DELETION_DELAY_DAYS` (30), `OBLIGATION_SERVICES`, `OBLIGATION_CHECK_DEADLINE_MS` (1 500), `ACCOUNT_DELETION_INTERVAL_MS` (15 min, 0 = désactivée), `ACCOUNT_DELETION_RECHECK_MINUTES` (60), `ACCOUNT_DELETION_BATCH_SIZE` (50).
8. **Messages** : notification envoie au titulaire « suppression demandée » (date prévue, comment annuler) et « suppression annulée ». Pas de message « suppression effectuée » : le compte anonymisé n'a plus de coordonnées ; la date est annoncée dès la demande.

## Alternatives écartées

- **Refuser toute connexion d'un compte gelé, annulation par un lien envoyé** : un lien dans un message est plus facile à voler qu'un code par téléphone, et il faudrait un second parcours.
- **Session normale pendant le délai, contrôles service par service** : chaque service devrait connaître l'état du compte ; une route oubliée resterait ouverte.
- **Date prévue recalculée à la lecture** : un changement du délai déplacerait les suppressions déjà annoncées au client.
- **Accord par défaut si un service ne répond pas** : une panne suffirait à supprimer un compte qui a une facture ou un paiement en cours.
- **Supprimer les lignes du compte** : les factures, paiements et missions y font référence (documents comptables, historique) ; l'anonymisation garde l'identifiant sans donnée personnelle.

## Conséquences

- Un jeton d'accès émis avant la demande reste valable jusqu'à son expiration (15 minutes au plus), comme après une déconnexion.
- `IDENTITY_DELETION_CHECK_UNAVAILABLE` est une erreur `UNAVAILABLE` : répétée en grand nombre, elle compte pour le coupe-circuit de la gateway vers identity (comme `IDENTITY_OTP_SEND_FAILED`).
- Le délai de la gateway pour la demande est porté à 6 secondes (contrôles en parallèle, 1,5 s chacun).
- Données personnelles hors d'identity, **à traiter** (à valider) : `notification` garde les notifications dans l'espace KSP (`in_app_notifications`, texte avec le prénom) et l'historique des envois (destinataire masqué) : à effacer ou à détacher sur `identity.user.deleted`. `billing` et `payment` ne gardent que l'identifiant du compte (documents comptables, durée de conservation légale à fixer) ; l'en-tête d'une facture est celui de l'organisation. `cleaning` efface déjà les positions (ADR-035) ; les adresses des demandes et missions restent (à valider).
- Chemin du portail cité dans les messages : `/mon-espace/compte` (à valider avec le portail).
- Les futurs services métier (`recovery`, `order`, `wallet`, `realestate`) devront implémenter `ObligationService` et être ajoutés à `OBLIGATION_SERVICES`.
