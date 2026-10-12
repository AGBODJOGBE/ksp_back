# ADR-005 — RabbitMQ pour les événements, avec outbox et inbox

**Statut** : Accepté

## Contexte

Un service doit pouvoir annoncer un fait (paiement reçu, utilisateur inscrit) sans connaître ceux qui l'exploitent, sans perte ni doublon.

## Décision

- Échange `ksp.events` de type _topic_ ; nom d'événement `<service>.<entité>.<action au passé>`.
- Publication par **outbox** : l'événement est écrit dans la même transaction que la donnée, puis relayé.
- Consommation par **inbox** : un événement reçu deux fois n'a qu'un effet.
- Par consommateur : file `<consommateur>.<événement>`, file `.retry` avec délai, file `.dlq` pour les échecs définitifs. Files répliquées (_quorum_).
- Enveloppe commune : `eventId` (UUID v7), `type`, `version`, `occurredAt`, `producer`, `correlationId`, `causationId`, `payload`. Schémas JSON dans `contracts/events/`.

## Alternatives écartées

- **Kafka** : surdimensionné pour le volume attendu, exploitation plus lourde.
- **Publication directe sans outbox** : perte d'événements en cas de panne entre la base et le broker.

## Conséquences

- Livraison _au moins une fois_ : tout consommateur doit être idempotent.
- Implémentation fournie par `libs/platform` (`SqlOutboxStore`, `SqlInboxStore`, `RabbitMqConsumer`).
