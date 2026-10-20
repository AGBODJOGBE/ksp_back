# Service notification

Contrat gRPC : `contracts/proto/ksp/notification/v1/notification.proto`. Événement publié : `notification.message.failed` (`contracts/events/notification/`). Décisions : ADR-014 (codes par gRPC direct), ADR-021 (WhatsApp Cloud API de Meta), ADR-013 et ADR-022 (jetons de service).

Le cahier des charges complet du service (notifications dans l'application, préférences, appareils, modèles, événements écoutés) reste à écrire. Ce service couvre le **lot 1** : l'envoi des codes de connexion d'identity.

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

| Règle           | Fonctionnement                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modèles         | `identity.otp` seul (variables `code`, 15 caractères au plus, et `expires_in_minutes`) ; tout autre modèle → `NOTIFICATION_TEMPLATE_UNKNOWN`. Modèle secret : ni le texte ni les variables ne sont stockés ni journalisés.                                              |
| Appelants       | `identity` et `document`, lus dans le jeton de service vérifié ; tout autre service → `NOTIFICATION_CALLER_FORBIDDEN`. Sans `IDENTITY_JWKS_URL` (développement), les appels ne sont pas authentifiés : le kit l'annonce au démarrage, et tout appelant est accepté.     |
| Canaux          | Le canal demandé (WhatsApp s'il n'est pas précisé), puis `fallback_channels` dans l'ordre. Un canal sans prestataire est sauté : au lancement, **WhatsApp seul** (aucun prestataire SMS, ADR-021).                                                                      |
| Idempotence     | Table `notifications`, clé `idempotency_key` unique : deux appels avec la même clé = un seul envoi, la seconde réponse (ou erreur) est celle du premier. Un second appel pendant le premier → `NOTIFICATION_ALREADY_IN_PROGRESS`.                                       |
| Délai           | `ttl_seconds` compte à partir de l'appel : passé ce délai, aucune bascule n'est plus tentée (cause `ttl_expired`). `0` : pas de limite.                                                                                                                                 |
| Réponse         | `DELIVERY_STATUS_ACCEPTED` quand le prestataire a pris le message en charge (jamais `SENT` sans accusé), `channel_used`, `notification_id`.                                                                                                                             |
| Échec           | Tous les canaux échouent → `NOTIFICATION_CHANNELS_EXHAUSTED` (`details.channelsTried`) et événement `notification.message.failed` par l'outbox, dans la même transaction que le statut. Numéro refusé par chaque prestataire appelé → `NOTIFICATION_RECIPIENT_INVALID`. |
| Refus immédiats | Numéro absent ou non E.164, identifiant de compte non UUID → `NOTIFICATION_RECIPIENT_INVALID` ; variables manquantes ou mal formées → `NOTIFICATION_VARIABLES_INVALID` (noms seuls). Rien n'est enregistré.                                                             |

## WhatsApp Cloud API (Meta)

`POST https://graph.facebook.com/<WHATSAPP_API_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages` avec `Authorization: Bearer <WHATSAPP_ACCESS_TOKEN>`, modèle d'authentification `WHATSAPP_OTP_TEMPLATE` (« Copier le code ») : le code est transmis dans le corps et dans le bouton. L'identifiant `wamid…` renvoyé est gardé dans `provider_message_id`.

| Réponse de Meta                                                     | Cause retenue          |
| ------------------------------------------------------------------- | ---------------------- |
| Erreur Graph 131026 (numéro sans WhatsApp) ou 131021                | `recipient_invalid`    |
| HTTP 5xx, 429, limites d'envoi, panne passagère, délai dépassé      | `provider_unavailable` |
| Autres refus (jeton expiré, modèle absent ou non approuvé, compte…) | `provider_rejected`    |

Les journaux ne contiennent ni le jeton, ni le numéro, ni le code : seulement le statut HTTP, le code d'erreur Graph et l'identifiant de trace de Meta (`fbtrace_id`). Délai maximum : `WHATSAPP_TIMEOUT_MS` (2 secondes par défaut, identity attend 3 secondes au plus).

## Prochaines étapes

- Statuts de remise WhatsApp (remis, lu, échoué) par webhook : reçus par la gateway sur `/webhooks/whatsapp`, transmis à notification qui vérifie la signature (UC-GW-11) et met à jour la notification retrouvée par `provider_message_id` (index à ajouter).
- Prestataire SMS (agrégateur à choisir avant la production, ADR-021).
- Reste du contrat après le cahier des charges du service.

## Organisation

| Dossier                           | Contenu                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/domain`                      | Canaux, modèles, destinataire, délai, résumé d'un échec, appelants autorisés               |
| `src/application/send`            | `SendNotificationUseCase`, ports (dépôt, fournisseur de canal), erreurs                    |
| `src/application/testing`         | Doublures en mémoire des ports                                                             |
| `src/infrastructure/channels`     | Prestataires WhatsApp (`MetaWhatsAppProvider`, `ConsoleWhatsAppProvider`) et leur fabrique |
| `src/infrastructure/notification` | Dépôt Prisma (table `notifications`, outbox)                                               |
| `src/interfaces/grpc`             | Contrôleur gRPC                                                                            |

Tests : `test/notification.repository.int.spec.ts` (PostgreSQL, ignoré sans `TEST_DATABASE_URL`) et `test/send-notification.grpc.spec.ts` (bout en bout gRPC avec le client d'identity).
