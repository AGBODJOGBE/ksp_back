# ADR-038 — Centre de notifications : lecture dans l'espace KSP, préférences de canaux, historique au back-office

**Statut** : Proposé

## Contexte

Depuis le lot 2, `notification` enregistre une notification dans l'espace KSP pour chaque message d'un événement (table `in_app_notifications`, titre, texte, lien) et garde l'historique de chaque envoi (table `notifications` : modèle, canaux, statut, cause d'échec, destinataire masqué ; jamais le texte ni les variables, ADR-014). Rien ne permettait de les lire : le portail n'avait pas de page de notifications, et le module « Notifications » du back-office était une page d'attente. Le cahier des charges du service (préférences, appareils, édition des modèles) n'est pas écrit.

## Décision

1. **Lecture dans l'espace KSP** — `ksp.notification.v1.InAppNotificationService`, réservé à la gateway, utilisateur lu dans le contexte de la requête :
   - `GET /api/v1/notification/notifications` : les plus récentes d'abord, pagination par curseur (identifiant du dernier élément, ordre `created_at, id` décroissants), filtre `unread=true`, nombre de non lues joint ;
   - `GET /api/v1/notification/notifications/unread-count` : pastille de l'en-tête ;
   - `POST /api/v1/notification/notifications/{id}/read` (idempotent : la première date de lecture reste) et `POST /api/v1/notification/notifications/read-all`.

   Chemins sous `/api/v1/notification/…` (convention `/api/v1/<service>/…` du manifeste) plutôt que `/api/v1/notifications`. **Filtre des non lues plutôt que « non lues en tête »** : un tri mêlant l'état de lecture déplacerait les éléments d'une page à l'autre pendant la lecture (curseur instable).

2. **Préférences de canaux** — `GET`/`PUT /api/v1/notification/preferences` (`whatsapp`, `email`, booléens ; WhatsApp et e-mail par défaut, table `notification_preferences`). Elles ne valent que pour les **messages facultatifs** : messages d'événements adressés au client (`.customer`) qui ne sont ni importants (impayés, suspension) ni de sécurité (demande et annulation de la suppression du compte). Partent toujours : codes de connexion et de confirmation, messages importants, messages des équipes KSP (`.agent`, `.team`). La notification de l'espace KSP est toujours enregistrée : tout écarter est donc permis. Le choix est lu au moment de l'événement (une lecture groupée par événement).

3. **Back-office** — `ksp.notification.v1.NotificationAdminService`, rôles **`super_admin` et `support_agent`** (direction et support client du catalogue d'identity ; les rôles métier ne voient pas les envois des autres métiers), double authentification de moins de 12 heures :
   - `GET /api/v1/admin/notification/deliveries` : historique, filtres modèle, canal essayé, statut, période (jours civils au Bénin, bornes incluses), compte destinataire (identifiant) ;
   - `GET /api/v1/admin/notification/deliveries/{id}` : canaux essayés, canal utilisé, code et cause d'échec, identifiant chez le prestataire, dates ;
   - `GET /api/v1/admin/notification/templates` : modèles et leur texte, en lecture seule.

   **Aucune donnée personnelle en clair** : destinataire masqué (`+229********45`), identifiant du compte seulement, jamais la clé d'idempotence (elle contient l'identifiant du compte) ni le texte d'un envoi (il n'est pas conservé). Un envoi détaché d'un compte supprimé est signalé (`erased`). Le texte des modèles est rendu avec le **nom des variables** entre accolades (`{first_name}`) : aucune valeur réelle, aucun code ; un texte qui dépend d'une valeur n'en montre qu'une variante.

4. **Suppression du compte (ADR-036)** : à `identity.user.deleted`, les préférences du compte sont supprimées avec ses notifications de l'espace, dans la même transaction que l'inbox.

5. **Page Contact du portail** : aucun service ne reçoit de message libre (pas de canal « contact » dans `notification`, aucune boîte gérée) ; la page donne les **moyens de contact directs** (WhatsApp par lien `wa.me`, téléphone, e-mail, adresse), lus dans la configuration du portail. Un formulaire viendra avec un canal backend (message vers l'équipe, anti-abus, consentement).

## Alternatives écartées

- **Pagination par numéro de page** : coûteuse sur une table qui grandit, et instable quand de nouvelles notifications arrivent.
- **Préférences par modèle ou par métier** : plus fin, mais un écran de dizaines de cases pour un gain faible au lancement ; le modèle (`isOptionalMessage`) permet de l'affiner sans changer le contrat des envois.
- **Préférences appliquées aussi aux messages importants** : un client pourrait ne jamais apprendre une suspension pour impayés.
- **Recherche par numéro de téléphone dans l'historique** : il faudrait conserver le numéro en clair ou une empreinte réversible par essais ; la recherche passe par le compte (identifiant), trouvé ailleurs au back-office.
- **Formulaire de contact envoyant un e-mail depuis la gateway** : la gateway n'a pas de règle métier ; un nouveau canal demande un cas d'usage, une limite anti-abus et une boîte de réception décidée par KSP.

## Conséquences

- La gateway doit pouvoir appeler `notification` : son client de service (`SERVICE_CLIENTS` d'identity, ADR-022) doit avoir `notification` dans ses `audiences`, et `NOTIFICATION_GRPC_URL` est ajoutée à sa configuration.
- Migration 0006 : table `notification_preferences`, index de l'historique (`created_at, id`), index partiel des non lues.
- Pas encore de notification en direct : le portail lit le nombre de non lues au chargement et à la demande.
- Le texte des messages reste dans le code (`domain/messages`) : l'édition au back-office attend le cahier des charges du service.
