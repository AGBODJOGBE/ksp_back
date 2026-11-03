import { type EventEnvelope } from '@ksp/contracts';
import { type InboxStore, type OutboxBatchResult, type OutboxRecord, type OutboxStore } from './ports';

/**
 * Sous-ensemble du client Prisma utilisé par l'outbox et l'inbox. Le kit ne dépend pas du client
 * généré de chaque service : tout client Prisma (ou transaction Prisma) satisfait cette interface.
 */
export interface SqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface TransactionalSqlClient extends SqlExecutor {
  $transaction<R>(
    fn: (tx: SqlExecutor) => Promise<R>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<R>;
}

/**
 * Tables attendues dans la base de chaque service (fournies par le modèle de service) :
 *   outbox(id uuid pk, event_type text, payload jsonb, created_at timestamptz, published_at timestamptz null, attempts int,
 *          next_attempt_at timestamptz null, parked_at timestamptz null, last_error text null,
 *          first_failed_at timestamptz null)
 *   processed_events(event_id uuid, consumer text, processed_at timestamptz, pk(event_id, consumer))
 */

/** Écrit un événement dans l'outbox. À appeler dans la même transaction que la modification métier. */
export async function appendToOutbox(tx: SqlExecutor, envelope: EventEnvelope): Promise<void> {
  await tx.$executeRawUnsafe(
    'INSERT INTO outbox (id, event_type, payload, created_at, attempts) VALUES ($1::uuid, $2, $3::jsonb, now(), 0)',
    envelope.eventId,
    envelope.type,
    JSON.stringify(envelope),
  );
}

interface OutboxRow {
  id: string;
  payload: EventEnvelope | string;
  attempts: number;
  first_failed_at: Date | string | null;
}

/** Délai de nouvelle tentative transmis à la base pour un événement mis de côté. */
const PARKED = -1;

export class SqlOutboxStore implements OutboxStore {
  constructor(
    private readonly client: TransactionalSqlClient,
    private readonly transactionTimeoutMs = 30_000,
  ) {}

  withUnpublishedBatch(
    limit: number,
    publish: (records: OutboxRecord[]) => Promise<OutboxBatchResult>,
  ): Promise<number> {
    return this.client.$transaction(
      async (tx) => {
        // Événements à publier : ni publiés, ni mis de côté, délai de nouvelle tentative écoulé.
        const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
          'SELECT id::text AS id, payload, attempts, first_failed_at FROM outbox ' +
            'WHERE published_at IS NULL AND parked_at IS NULL ' +
            'AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ' +
            'ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED',
          limit,
        );
        if (rows.length === 0) return 0;
        const records = rows.map((row) => ({
          id: row.id,
          attempts: row.attempts,
          firstFailedAt: row.first_failed_at ? new Date(row.first_failed_at) : null,
          envelope:
            typeof row.payload === 'string' ? (JSON.parse(row.payload) as EventEnvelope) : row.payload,
        }));
        const { published, failed } = await publish(records);
        if (published.length > 0) {
          await tx.$executeRawUnsafe(
            'UPDATE outbox SET published_at = now(), next_attempt_at = NULL, last_error = NULL ' +
              'WHERE id = ANY($1::uuid[])',
            published,
          );
        }
        if (failed.length > 0) {
          // Tous les échecs en une requête : tentative comptée, premier échec daté s'il ne l'était pas,
          // puis prochaine tentative (délai en millisecondes) ou mise de côté (PARKED).
          await tx.$executeRawUnsafe(
            'UPDATE outbox AS o SET attempts = o.attempts + 1, ' +
              'first_failed_at = COALESCE(o.first_failed_at, now()), ' +
              `parked_at = CASE WHEN f.retry_ms = ${PARKED} THEN now() ELSE NULL END, ` +
              `next_attempt_at = CASE WHEN f.retry_ms = ${PARKED} THEN NULL ` +
              "ELSE now() + (f.retry_ms * interval '1 millisecond') END, " +
              'last_error = f.error ' +
              'FROM unnest($1::uuid[], $2::bigint[], $3::text[]) AS f(id, retry_ms, error) ' +
              'WHERE o.id = f.id',
            failed.map((failure) => failure.id),
            failed.map((failure) =>
              failure.retryInMs === null ? PARKED : Math.max(0, Math.round(failure.retryInMs)),
            ),
            failed.map((failure) => failure.error),
          );
        }
        return published.length;
      },
      { timeout: this.transactionTimeoutMs },
    );
  }

  /**
   * Rejoue les événements mis de côté (ADR-032), une fois la cause corrigée : tous, ou ceux dont
   * l'identifiant est donné (commande `pnpm outbox:replay`). Ils repartent comme neufs : compteur de
   * tentatives à zéro, premier échec effacé (la durée avant mise de côté repart de zéro). Renvoie
   * leur nombre.
   */
  replayParked(ids?: string[]): Promise<number> {
    const reset =
      'UPDATE outbox SET parked_at = NULL, attempts = 0, next_attempt_at = NULL, first_failed_at = NULL ' +
      'WHERE parked_at IS NOT NULL AND published_at IS NULL';
    return ids
      ? this.client.$executeRawUnsafe(`${reset} AND id = ANY($1::uuid[])`, ids)
      : this.client.$executeRawUnsafe(reset);
  }
}

export class SqlInboxStore implements InboxStore<SqlExecutor> {
  constructor(private readonly client: TransactionalSqlClient) {}

  runOnce(
    eventId: string,
    consumer: string,
    work: (tx: SqlExecutor) => Promise<void>,
  ): Promise<'processed' | 'duplicate'> {
    return this.client.$transaction(async (tx) => {
      const inserted = await tx.$executeRawUnsafe(
        'INSERT INTO processed_events (event_id, consumer, processed_at) VALUES ($1::uuid, $2, now()) ON CONFLICT DO NOTHING',
        eventId,
        consumer,
      );
      if (inserted === 0) return 'duplicate';
      await work(tx);
      return 'processed';
    });
  }
}
