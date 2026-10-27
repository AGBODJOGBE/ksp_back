# Service notification

Contrat gRPC : `contracts/proto/ksp/notification/v1/notification.proto`. Événement publié : `notification.message.failed` (`contracts/events/notification/`). Événements écoutés : les 11 événements du Nettoyage (`contracts/events/cleaning/`). Décisions : ADR-014 (codes par gRPC direct), ADR-021 (WhatsApp Cloud API de Meta), ADR-024 (e-mail par Brevo), ADR-013 et ADR-022 (jetons de service).

Le cahier des charges complet du service (préférences, appareils, édition des modèles, lecture des notifications dans l'application) reste à écrire. Ce service couvre le **lot 1** (envoi des codes de connexion d'identity) et le **lot 2** (messages des événements du Nettoyage, par WhatsApp, e-mail et dans l'espace KSP).

## Démarrer en local

```bash
cp .env.example .env
pnpm --filter @ksp/notification-service prisma:migrate   # crée les tables
pnpm --filter @ksp/notification-service dev
```

- gRPC : `localhost:50052` (adresse attendue par identity, `NOTIFICATION_GRPC_URL`)
- Santé : `http://localhost:3102/health/live` et `/health/ready`
- Métriques : `http://localhost:3102/metrics`

### Se connecter sans téléphone (développement)

Avec `NOTIFICATION_WHATSAPP_PROVIDER=console` (valeur par défaut hors production), aucun message ne part : le code demandé par identity est écrit dans le terminal du service :

```
[notification · développement] WhatsApp vers +229********45 — identity.otp : code=482913, expires_in_minutes=5
```

C'est **le seul endroit** où un code de connexion peut apparaître dans une sortie du service, et seulement en développement. Le garde-fou est double : la configuration refuse `console` quand `NODE_ENV=production` (le service ne démarre pas), et la fabrique des prestataires le vérifie une seconde fois. En production, le prestataire par défaut est `meta`.

## SendNotification (lot 1)

| Règle           | Fonctionnement                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modèles         | `identity.otp` (WhatsApp ou SMS ; variables `code`, 15 caractères au plus, et `expires_in_minutes`) et `identity.email_verification` (e-mail seul, `recipient.email` obligatoire ; `code` de 4 à 8 chiffres, `expires_in_minutes` ; texte dans `domain/messages/identity.messages.ts`, code absent de l'objet). Tout autre modèle → `NOTIFICATION_TEMPLATE_UNKNOWN`. Modèles secrets : ni le texte ni les variables ne sont stockés ni journalisés. |
| Appelants       | `identity` et `document`, lus dans le jeton de service vérifié ; tout autre service → `NOTIFICATION_CALLER_FORBIDDEN`. Sans `IDENTITY_JWKS_URL` (développement), les appels ne sont pas authentifiés : le kit l'annonce au démarrage, et tout appelant est accepté.                                                                                                                                                                                 |
| Canaux          | Le canal demandé (WhatsApp s'il n'est pas précisé), puis `fallback_channels` dans l'ordre. Un canal sans prestataire est sauté : au lancement, **WhatsApp seul** (aucun prestataire SMS, ADR-021).                                                                                                                                                                                                                                                  |
| Idempotence     | Table `notifications`, clé `idempotency_key` unique : deux appels avec la même clé = un seul envoi, la seconde réponse (ou erreur) est celle du premier. Un second appel pendant le premier → `NOTIFICATION_ALREADY_IN_PROGRESS`.                                                                                                                                                                                                                   |
| Délai           | `ttl_seconds` compte à partir de l'appel : passé ce délai, aucune bascule n'est plus tentée (cause `ttl_expired`). `0` : pas de limite.                                                                                                                                                                                                                                                                                                             |
| Réponse         | `DELIVERY_STATUS_ACCEPTED` quand le prestataire a pris le message en charge (jamais `SENT` sans accusé), `channel_used`, `notification_id`.                                                                                                                                                                                                                                                                                                         |
| Échec           | Tous les canaux échouent → `NOTIFICATION_CHANNELS_EXHAUSTED` (`details.channelsTried`) et événement `notification.message.failed` par l'outbox, dans la même transaction que le statut. Numéro refusé par chaque prestataire appelé → `NOTIFICATION_RECIPIENT_INVALID`.                                                                                                                                                                             |
| Refus immédiats | Coordonnée absente ou mal formée pour un canal prévu (numéro E.164 pour WhatsApp et SMS, adresse pour l'e-mail), identifiant de compte non UUID → `NOTIFICATION_RECIPIENT_INVALID` ; variables manquantes ou mal formées → `NOTIFICATION_VARIABLES_INVALID` (noms seuls). Rien n'est enregistré.                                                                                                                                                    |

## WhatsApp Cloud API (Meta)

`POST https://graph.facebook.com/<WHATSAPP_API_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages` avec `Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>`, modèle d'authentification `WHATSAPP_OTP_TEMPLATE` (« Copier le code ») : le code est transmis dans le corps et dans le bouton. L'identifiant `wamid…` renvoyé est gardé dans `provider_message_id`.

| Réponse de Meta                                                     | Cause retenue          |
| ------------------------------------------------------------------- | ---------------------- |
| Erreur Graph 131026 (numéro sans WhatsApp) ou 131021                | `recipient_invalid`    |
| HTTP 5xx, 429, limites d'envoi, panne passagère, délai dépassé      | `provider_unavailable` |
| Autres refus (jeton expiré, modèle absent ou non approuvé, compte…) | `provider_rejected`    |

Les journaux ne contiennent ni le jeton, ni le numéro, ni le code : seulement le statut HTTP, le code d'erreur Graph et l'identifiant de trace de Meta (`fbtrace_id`). Délai maximum : `WHATSAPP_TIMEOUT_MS` (2 secondes par défaut, identity attend 3 secondes au plus).

## Messages des événements (lot 2)

Chaque événement écouté a sa file `notification.<événement>` (quorum), sa file de reprise `.retry` (10 secondes, 5 reprises) et sa file d'erreurs `.dlq`, créées par le kit. Le traitement (`NotifyEventUseCase`) :

1. ignore un événement déjà traité (inbox, table `processed_events`) ;
2. déduit de l'événement les messages à envoyer (`application/events/cleaning.rules.ts`) et lit les coordonnées des destinataires dans identity (`GetUsersByIds`, jeton de service) ; identity indisponible → reprise par la file. **Seule une adresse e-mail vérifiée par code (`email_verified`) est retenue** : sans elle, aucun e-mail ne part (devis, compte rendu, avis d'impayés, factures) et le message reste visible dans l'espace KSP ;
3. envoie un message par destinataire, avec la clé d'idempotence `<événement>:<modèle>:<destinataire>` (table `notifications`) : une nouvelle livraison n'envoie rien deux fois ;
4. marque l'événement traité et enregistre une notification par destinataire dans `in_app_notifications`, dans la même transaction.

Un destinataire introuvable (compte inconnu ou supprimé) est sauté ; un échec de tous les canaux publie `notification.message.failed` sans bloquer l'événement. Les journaux ne contiennent que l'identifiant de l'événement et des compteurs.

**Règle de choix du canal** (`eventChannelPlan`) : un seul message externe par destinataire, plus la notification dans l'espace.

| Nature du message                                | Canal                                                  |
| ------------------------------------------------ | ------------------------------------------------------ |
| Court, transactionnel (demande reçue, planning…) | WhatsApp ; e-mail en bascule si l'adresse est vérifiée |
| Document (devis envoyé, compte rendu de fin)     | E-mail si l'adresse est vérifiée ; WhatsApp sinon      |
| Important (avertissement d'impayés, suspension)  | WhatsApp **et** e-mail (deux envois, sans bascule)     |
| Destinataire sans téléphone ni e-mail            | Notification dans l'espace seulement                   |

| Événement                              | Destinataires            | Modèles                                                                                 |
| -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `cleaning.quote.requested`             | client                   | `cleaning.quote_requested.customer` (visite annoncée si `visitRequired`)                |
| `cleaning.visit.scheduled`             | client, agent            | `cleaning.visit_scheduled.customer`, `cleaning.visit_scheduled.agent`                   |
| `cleaning.quote.sent`                  | client                   | `cleaning.quote_sent.customer` (document)                                               |
| `cleaning.booking.confirmed`           | client                   | `cleaning.booking_confirmed.customer` (montant, passages, paiement choisi)              |
| `cleaning.mission.scheduled`           | client, chaque agent     | `cleaning.mission_scheduled.customer`, `cleaning.mission_scheduled.agent`               |
| `cleaning.mission.completed`           | client                   | `cleaning.mission_completed.customer` (document)                                        |
| `cleaning.request.cancelled`           | client                   | `cleaning.request_cancelled.customer` (texte selon le motif)                            |
| `cleaning.contract.suspension_warning` | client                   | `cleaning.suspension_warning.customer` (important : seuil de suspension annoncé)        |
| `cleaning.contract.suspended`          | client, agents libérés   | `cleaning.contract_suspended.customer` (important), `cleaning.contract_suspended.agent` |
| `cleaning.contract.resumed`            | client, équipe Nettoyage | `cleaning.contract_resumed.customer`, `cleaning.contract_resumed.team`                  |
| `cleaning.rescheduling.failed`         | équipe Nettoyage         | `cleaning.rescheduling_failed.team`                                                     |

Équipe Nettoyage : comptes listés dans `NOTIFICATION_CLEANING_TEAM_USER_IDS` (identifiants séparés par des virgules, vide par défaut), car ces événements ne désignent ni l'admin ni le superviseur. Lien des factures : `PORTAL_BASE_URL` + `/mon-espace/factures`.

Textes : `src/domain/messages/cleaning.messages.ts` (français, dates à l'heure du Bénin, montants en FCFA entiers). Liens : `PORTAL_BASE_URL` + `/mon-espace/nettoyage/demandes/<id>` ou `/missions/<id>`.

**Ajouter un événement** (suspension, reprise, facture…) : ses modèles dans `domain/messages`, sa règle dans `application/events`, l'entrée dans `listened-events.ts`, le modèle WhatsApp dans `infrastructure/channels/whatsapp-templates.ts`.

### Modèles WhatsApp à faire approuver par Meta

Un message envoyé à l'initiative de KSP exige un modèle approuvé (catégorie « utility », français). Paramètres du corps dans l'ordre ; `{{1}}` est toujours le prénom (« Madame, Monsieur » s'il manque).

| Modèle Meta                                                                                                                    | Paramètres                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `ksp_cleaning_quote_requested`, `ksp_cleaning_quote_requested_visit`                                                           | prénom, lien                                                   |
| `ksp_cleaning_visit_scheduled`                                                                                                 | prénom, date, lien                                             |
| `ksp_cleaning_visit_assigned`                                                                                                  | prénom, date                                                   |
| `ksp_cleaning_quote_sent`                                                                                                      | prénom, montant, date de validité, lien                        |
| `ksp_cleaning_booking_confirmed`                                                                                               | prénom, nombre de passages, montant, paiement, lien            |
| `ksp_cleaning_mission_scheduled`                                                                                               | prénom, date, durée, lien                                      |
| `ksp_cleaning_mission_assigned`                                                                                                | prénom, date, durée                                            |
| `ksp_cleaning_mission_completed`                                                                                               | prénom, passages réalisés, date, lien                          |
| `ksp_cleaning_cancelled_by_customer`, `ksp_cleaning_cancelled_by_supervisor`, `ksp_cleaning_rejected`, `ksp_cleaning_declined` | prénom, « votre demande » ou « votre prestation », lien        |
| `ksp_cleaning_suspension_warning`                                                                                              | prénom, impayés (« 1 facture impayée »), seuil, lien           |
| `ksp_cleaning_contract_suspended`                                                                                              | prénom, impayés, lien                                          |
| `ksp_cleaning_interventions_cancelled`                                                                                         | prénom                                                         |
| `ksp_cleaning_contract_resumed`                                                                                                | prénom, passages reprogrammés, passages à replanifier, lien    |
| `ksp_cleaning_team_contract_resumed`                                                                                           | prénom, mission, passages reprogrammés, passages à replanifier |
| `ksp_cleaning_team_rescheduling_failed`                                                                                        | prénom, mission, passages à replanifier                        |

## E-mail (Brevo)

`POST https://api.brevo.com/v3/smtp/email`, clé dans l'en-tête `api-key`, expéditeur `EMAIL_SENDER_NAME <EMAIL_SENDER_ADDRESS>` ; objet, texte brut et HTML échappé. L'identifiant `messageId` est gardé dans `provider_message_id`. Panne, 429 ou quota du jour épuisé (402) → `provider_unavailable` ; 400 `invalid_parameter` → `recipient_invalid` ; autres refus → `provider_rejected`. Les journaux ne contiennent ni la clé, ni l'adresse, ni le texte. Avec `NOTIFICATION_EMAIL_PROVIDER=console` (défaut hors production, refusé en production), l'e-mail est écrit dans le terminal avec l'adresse masquée.

## Prochaines étapes

- Lecture des notifications dans l'application (liste, marquer comme lue) : RPC à ajouter au contrat, puis routes de la gateway ; événement de notification en direct à définir.
- Événements à brancher : facturation (billing).
- Statuts de remise WhatsApp (remis, lu, échoué) par webhook : reçus par la gateway sur `/webhooks/whatsapp`, transmis à notification qui vérifie la signature (UC-GW-11) et met à jour la notification retrouvée par `provider_message_id` (index à ajouter).
- Prestataire SMS (agrégateur à choisir avant la production, ADR-021).
- Reste du contrat après le cahier des charges du service.

## Organisation

| Dossier                           | Contenu                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/domain`                      | Canaux, modèles, destinataire, délai, résumé d'un échec, appelants autorisés                      |
| `src/domain/messages`             | Textes des messages des événements, mise en forme (montants, dates, durées)                       |
| `src/application/send`            | `SendNotificationUseCase`, `MessageDispatcher` (envoi idempotent partagé), ports, erreurs         |
| `src/application/events`          | `NotifyEventUseCase`, règles par événement, ports (annuaire, inbox)                               |
| `src/application/testing`         | Doublures en mémoire des ports                                                                    |
| `src/infrastructure/channels`     | Prestataires WhatsApp (Meta, console) et e-mail (Brevo, console), leur fabrique, modèles WhatsApp |
| `src/infrastructure/events`       | Inbox et notifications dans l'espace (tables `processed_events`, `in_app_notifications`)          |
| `src/infrastructure/identity`     | Annuaire des destinataires (identity, `GetUsersByIds`)                                            |
| `src/infrastructure/notification` | Dépôt Prisma (table `notifications`, outbox)                                                      |
| `src/interfaces/grpc`             | Contrôleur gRPC                                                                                   |
| `src/interfaces/messaging`        | Abonnement RabbitMQ aux événements écoutés                                                        |

Tests : `test/notification.repository.int.spec.ts` et `test/event-inbox.int.spec.ts` (PostgreSQL, ignorés sans `TEST_DATABASE_URL`) et `test/send-notification.grpc.spec.ts` (bout en bout gRPC avec le client d'identity).
