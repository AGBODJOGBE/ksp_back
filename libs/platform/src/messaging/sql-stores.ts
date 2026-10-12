import { type EventEnvelope } from '@ksp/contracts';
import { type InboxStore, type OutboxRecord, type OutboxStore } from './ports';

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
 *   outbox(id uuid pk, event_type text, payload jsonb, created_at timestamptz, published_at timestamptz null, attempts int)
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
}

export class SqlOutboxStore implements OutboxStore {
  constructor(
    private readonly client: TransactionalSqlClient,
    private readonly transactionTimeoutMs = 30_000,
  ) {}

  withUnpublishedBatch(
    limit: number,
    publish: (records: OutboxRecord[]) => Promise<string[]>,
  ): Promise<number> {
    return this.client.$transaction(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
          'SELECT id::text AS id, payload, attempts FROM outbox WHERE published_at IS NULL ' +
            'ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED',
          limit,
        );
        if (rows.length === 0) return 0;
        const records = rows.map((row) => ({
          id: row.id,
          attempts: row.attempts,
          envelope:
            typeof row.payload === 'string' ? (JSON.parse(row.payload) as EventEnvelope) : row.payload,
        }));
        const published = await publish(records);
        if (published.length > 0) {
          await tx.$executeRawUnsafe(
            'UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])',
            published,
          );
        }
        const failed = records.find((record) => !published.includes(record.id));
        if (failed) {
          await tx.$executeRawUnsafe(
            'UPDATE outbox SET attempts = attempts + 1 WHERE id = $1::uuid',
            failed.id,
          );
        }
        return published.length;
      },
      { timeout: this.transactionTimeoutMs },
    );
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
