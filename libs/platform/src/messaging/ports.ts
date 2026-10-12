import { type EventEnvelope } from '@ksp/contracts';

/** Publie un événement sur le broker. */
export interface EventPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

export interface OutboxRecord {
  id: string;
  envelope: EventEnvelope;
  attempts: number;
}

/**
 * Stockage de l'outbox. `withUnpublishedBatch` verrouille un lot d'événements non publiés
 * (aucune autre instance ne peut le prendre), appelle `publish`, puis marque comme publiés
 * les identifiants renvoyés. Renvoie le nombre d'événements publiés.
 */
export interface OutboxStore {
  withUnpublishedBatch(
    limit: number,
    publish: (records: OutboxRecord[]) => Promise<string[]>,
  ): Promise<number>;
}

/**
 * Stockage de l'inbox : garantit qu'un événement n'est traité qu'une fois par consommateur.
 * `work` reçoit la transaction dans laquelle l'événement est marqué comme traité,
 * pour que l'effet métier et la marque soient enregistrés ensemble.
 */
export interface InboxStore<Tx> {
  runOnce(
    eventId: string,
    consumer: string,
    work: (tx: Tx) => Promise<void>,
  ): Promise<'processed' | 'duplicate'>;
}
