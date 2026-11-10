# ADR-047 — Messagerie fiable

**Statut** : Proposé (corrections issues de la revue de code, 2026-11-10)

## Contexte

La revue de code de la messagerie (kit `libs/platform`, ADR-005, ADR-032) a relevé des pertes possibles
d'événements, toutes silencieuses :

- un abonnement dont le canal tombe (redémarrage du broker, erreur de canal) n'était jamais refait : le
  service ne consommait plus rien, sans alerte ;
- la copie d'un message vers la file de reprise ou d'erreurs était acquittée sans attendre la
  confirmation du broker, et les files de reprise étaient des files classiques non répliquées, alors
  qu'ADR-017 veut des files quorum ;
- une file quorum supprime un message remis 20 fois sans acquittement (limite par défaut de
  RabbitMQ 4), sans le faire passer par la `.dlq` ;
- un événement publié avant le premier démarrage d'un nouveau consommateur (file pas encore déclarée)
  était perdu : la publication n'était pas « mandatory » ;
- le publieur ne redéclarait pas l'exchange après une reconnexion ;
- la fenêtre de nouvel essai par défaut était d'environ 50 s (seul `billing` l'allongeait) ;
- l'émetteur (`producer`) et la version de l'enveloppe n'étaient jamais vérifiés à la réception ;
- l'inbox gardait le délai de transaction de Prisma (5 s), et ni l'outbox publiée ni
  `processed_events` n'étaient purgées ;
- une notification réservée (`pending`) dont l'envoi n'avait jamais eu lieu était vue comme déjà faite
  au rejeu ;
- RabbitMQ figurait dans la sonde « prêt » : une panne du broker retirait tous les services du trafic,
  contrairement à ADR-032 (l'outbox garde les événements) ;
- aucune métrique de l'outbox ni des files d'erreurs ; le rejeu des `.dlq` ne connaissait que la
  version 1 des événements.

## Décision

1. **Abonnement rétabli** (`RabbitMqConsumer`) : chaque canal consommateur est surveillé ; fermé sans
   que le service l'ait demandé (canal fermé par le broker, connexion coupée, consommateur annulé par
   le broker), l'abonnement est rouvert — canal, topologie, consommation — après 1 s, délai doublé à
   chaque échec jusqu'à 30 s. Rien n'est rouvert après `close()` du consommateur ou de la connexion.
   Une erreur imprévue du traitement d'un message est journalisée (plus de promesse rejetée ignorée).
2. **Copies confirmées** : la copie vers une file de reprise ou d'erreurs est confirmée par le broker
   avant l'acquittement du message d'origine ; une copie refusée rend le message à sa file (remis plus
   tard). Livraison « au moins une fois », gestionnaires idempotents (inbox).
3. **Files de reprise quorum**, une par délai, **nommées par leur délai** (`<file>.retry.10s`,
   `.retry.30s`, `.retry.1m`…), avec `x-dead-letter-strategy: at-least-once` (qui impose
   `x-overflow: reject-publish`) pour leur retour dans la file principale. RabbitMQ 4.1 accepte le TTL
   et le renvoi « au moins une fois » sur une file quorum (vérifié sur le broker local). Le délai étant
   dans le nom, changer les délais crée d'autres files au lieu de redéclarer une file avec d'autres
   arguments (`PRECONDITION_FAILED`).
4. **Délais croissants par défaut** dans le kit : 10 s, 30 s, 1 min, 2 min, 5 min, 10 min, 15 min,
   30 min (environ 1 h 04, ceux de `billing` depuis ADR-032), puis la `.dlq`
   (`DEFAULT_RETRY_DELAYS_MS`, réglable par `consumerRetryDelaysMs`).
5. **Remises sans acquittement bornées** : un message remis 10 fois sans acquittement (le consommateur
   tombe en le traitant ; en-tête `x-delivery-count` des files quorum) part en `.dlq` sans être traité,
   avec une alerte, avant la limite de 20 où RabbitMQ le supprimerait. Ce contrôle remplace l'ajout
   d'un échange d'erreurs à la file principale, refusé par RabbitMQ sur une file existante (voir
   Alternatives).
6. **Émetteur et version vérifiés à la réception** : un événement dont `producer` n'est pas le service
   propriétaire du type (préfixe du type : `payment.*` ↔ `payment`, `identity.*` ↔ `identity`…), ou dont
   la version n'est pas comprise par le gestionnaire (1 par défaut, option `versions`
   de `subscribe`), part en `.dlq` sans être traité, avec une alerte `ALERTE messagerie`. La vérification
   vaut pour tous les services consommateurs. Elle arrête une erreur de publication ou un événement
   forgé avec un mauvais émetteur ; elle ne remplace pas les droits du broker (voir Conséquences).
7. **Publication « mandatory »** : un événement attendu par au moins un consommateur que le broker n'a
   pu remettre à aucune file est un échec de publication ; l'outbox le garde et réessaie (ADR-032)
   jusqu'à ce que la file existe. Les abonnements sont déclarés dans `EVENT_CONSUMERS`
   (`libs/platform/src/messaging/consumed-events.ts`), à tenir à jour avec chaque `subscribe` ; un
   abonnement absent de cette liste est signalé au démarrage (`ALERTE messagerie`). Un événement que
   personne n'attend (par exemple `identity.user.verified`), non routé, est abandonné sans erreur,
   comme avant. L'exchange est déclaré sur chaque nouveau canal de publication.
8. **Inbox et purge** : la transaction de l'inbox a 30 s par défaut (comme l'outbox), réglable. Le
   relais de chaque service purge chaque heure, par lots de 5 000, l'outbox publiée et
   `processed_events` au-delà de 30 jours (`SqlMessageRetention`, réglable).
9. **Notification reprise** : une notification encore `pending` 10 minutes après sa réservation (ou sa
   dernière reprise) est reprise par un appel de même clé (rejeu d'événement, nouvel appel gRPC) et
   envoyée sous son identifiant d'origine. La reprise est une mise à jour conditionnelle, atomique :
   un seul appel la gagne ; elle est datée (`claimed_at`) pour ne pas être reprise de suite. Une
   notification acceptée ou en échec n'est jamais reprise.
10. **Sonde « prêt » sans RabbitMQ** : seule la base y reste. L'état de la connexion est exposé par la
    métrique `rabbitmq_connection_up`.
11. **Métriques** (`/metrics`, en plus des alertes de journal existantes) : `outbox_pending`,
    `outbox_parked` (lues à chaque collecte), `outbox_publish_failures_total`,
    `rabbitmq_connection_up`, `rabbitmq_dlq_messages{queue}` (profondeur des `.dlq` des abonnements du
    service), `messaging_dead_lettered_total{queue,reason}` (`invalid_envelope`, `unexpected_producer`,
    `unsupported_version`, `redelivery_limit`, `retries_exhausted`).
12. **Rejeu des `.dlq`** (`pnpm dlq:replay`) : toutes les versions des schémas d'événements sont
    reconnues.
13. **Tests d'intégration réels** du kit (`libs/platform/test/rabbitmq.int.spec.ts`) : abonnement
    rétabli après la fermeture du canal par le broker, publication non routée en échec, exchange
    redéclaré, `.dlq` après les tentatives, émetteur refusé, message qui fait tomber le consommateur,
    files quorum. La CI fournit RabbitMQ 4.1 (`TEST_RABBITMQ_URL`).

## Compatibilité et déploiement

- **Files principales et `.dlq`** : inchangées (mêmes noms, mêmes arguments) ; aucune redéclaration
  refusée.
- **Anciennes files de reprise** (`<file>.retry` classiques de tous les services, `<file>.retry.1` à
  `.retry.8` de `billing`) : plus alimentées. Les messages qui y attendent reviennent seuls dans la file
  principale à l'expiration de leur délai. Elles peuvent être supprimées une fois vides, au plus tôt
  30 minutes après le déploiement de tous les services.
- **Ordre** : aucun ordre imposé entre services pour le kit (tous les services publient déjà avec leur
  propre nom comme `producer`). Pour un **nouvel abonnement** : le déclarer dans `EVENT_CONSUMERS` ;
  publié avant le démarrage du consommateur, l'événement reste dans l'outbox du producteur (et y
  réessaie) jusqu'à la déclaration de la file au démarrage du consommateur. Au-delà de 24 heures, il
  est mis de côté avec une alerte et se rejoue par `pnpm outbox:replay` (ADR-032) : déployer le
  consommateur avant ou avec le producteur.
- **`notification`** : migration `0007_pending_claim_resume` (colonne facultative `claimed_at`).
- **Purge** : la première passe d'un service ancien peut supprimer beaucoup de lignes, par lots.

## Alternatives écartées

- **Échange d'erreurs (`x-dead-letter-exchange`) sur la file principale** : RabbitMQ refuse de
  redéclarer une file existante avec d'autres arguments (`PRECONDITION_FAILED`, vérifié sur 4.1), et
  une politique du broker ne sait pas donner à chaque file sa propre `.dlq`. Il faudrait renommer
  toutes les files principales (double livraison pendant la transition, anciennes files à vider). Le
  contrôle du nombre de remises (décision 5) couvre le même cas sans migration.
- **Traiter tout retour comme un échec**, sans liste des abonnements : chaque événement que personne
  n'écoute (13 sur 44 aujourd'hui) échouerait en boucle puis serait mis de côté avec une alerte.
- **Lien de secours (« alternate exchange ») sur `ksp.events`** : tout serait routé, le retour
  « mandatory » ne signalerait plus jamais une file manquante.
- **Tâche qui passe en échec les notifications `pending` anciennes** : l'événement serait perdu pour le
  destinataire ; la reprise envoie le message.
- **Garder RabbitMQ dans la sonde « prêt » en le rendant tolérant** : la sonde dit si le service peut
  servir ; il le peut sans broker.

## Conséquences

- À surveiller : `ALERTE messagerie` (émetteur ou version refusés, remises sans acquittement, abonnement
  non déclaré), `rabbitmq_dlq_messages > 0`, `outbox_parked > 0`, `rabbitmq_connection_up == 0`
  durable, croissance de `outbox_pending`.
- La vérification de l'émetteur porte sur le contenu du message : un service qui a les droits de
  publication sur `ksp.events` peut encore forger un `producer`. À compléter côté infrastructure
  (`ksp-infra`) par un utilisateur RabbitMQ par service, limité en écriture aux types qu'il possède
  (droits par sujet du broker, `^payment\.` pour `payment`).
- Rétention de 30 jours de l'inbox : un message rejoué plus tard depuis une `.dlq` après avoir déjà été
  traité serait retraité ; les `.dlq` sont à traiter bien avant.
- Fenêtre de nouvel essai d'environ 1 h 04 pour tous les services : un gestionnaire en échec durable
  garde ses messages plus longtemps hors de la `.dlq`.
