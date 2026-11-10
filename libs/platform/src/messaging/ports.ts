import { type EventEnvelope } from '@ksp/contracts';
import { type OutboxStats } from './metrics';

/** Publie un événement sur le broker. */
export interface EventPublisher {
  publish(envelope: EventEnvelope): Promise<void>;
}

export interface OutboxRecord {
  id: string;
  envelope: EventEnvelope;
  /** Tentatives de publication déjà échouées. */
  attempts: number;
  /**
   * Premier échec de publication, null si l'événement n'a jamais échoué (ou a été rejoué). La mise
   * de côté se mesure depuis cet instant (ADR-032).
   */
  firstFailedAt: Date | null;
}

/** Échec de publication imputé à un événement (ADR-032). */
export interface OutboxFailure {
  id: string;
  /** Message d'erreur du broker (jamais le contenu de l'événement). */
  error: string;
  /** Délai avant la prochaine tentative ; null : l'événement est mis de côté (échecs depuis trop longtemps). */
  retryInMs: number | null;
}

/** Issue d'un passage sur un lot : publiés, et échecs imputés aux événements. */
export interface OutboxBatchResult {
  published: string[];
  failed: OutboxFailure[];
}

/**
 * Stockage de l'outbox. `withUnpublishedBatch` verrouille un lot d'événements à publier (non
 * publiés, non mis de côté, dont le délai de nouvelle tentative est écoulé ; aucune autre instance
 * ne peut le prendre), appelle `publish`, puis marque les publiés et enregistre les échecs
 * (tentative comptée, premier échec daté, prochaine tentative ou mise de côté). Les événements du
 * lot que `publish` ne cite ni dans l'un ni dans l'autre restent en attente, inchangés. Renvoie le
 * nombre d'événements publiés.
 */
export interface OutboxStore {
  withUnpublishedBatch(
    limit: number,
    publish: (records: OutboxRecord[]) => Promise<OutboxBatchResult>,
  ): Promise<number>;
  /** Nombre d'événements en attente et mis de côté (métriques `outbox_pending` et `outbox_parked`). */
  stats?(): Promise<OutboxStats>;
}

/** Purge des messages devenus inutiles (outbox publiée, inbox) au-delà de la rétention. */
export interface MessageRetention {
  /** Renvoie le nombre de lignes supprimées. */
  purge(): Promise<number>;
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
