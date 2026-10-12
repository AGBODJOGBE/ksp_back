import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { createEnvelope } from '../src/messaging/envelope';
import {
  appendToOutbox,
  type SqlExecutor,
  SqlInboxStore,
  SqlOutboxStore,
  type TransactionalSqlClient,
} from '../src/messaging/sql-stores';

/**
 * Test d'intégration contre un vrai PostgreSQL : vérifie les requêtes de l'outbox et de l'inbox
 * avec la migration initiale du modèle de service. Ignoré si TEST_DATABASE_URL n'est pas défini
 * (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATION = join(
  __dirname,
  '../../../tools/new-service/template/prisma/migrations/0001_init/migration.sql',
);

/** Adaptateur pg → interface attendue par le kit (même forme que le client Prisma). */
function executor(client: PoolClient | Client): SqlExecutor {
  return {
    $queryRawUnsafe: async <T>(query: string, ...values: unknown[]) =>
      (await client.query(query, values)).rows as T,
    $executeRawUnsafe: async (query: string, ...values: unknown[]) =>
      (await client.query(query, values)).rowCount ?? 0,
  };
}

function transactional(pool: Pool): TransactionalSqlClient {
  return {
    $queryRawUnsafe: async <T>(query: string, ...values: unknown[]) =>
      (await pool.query(query, values)).rows as T,
    $executeRawUnsafe: async (query: string, ...values: unknown[]) =>
      (await pool.query(query, values)).rowCount ?? 0,
    $transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(executor(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const envelope = () =>
  createEnvelope('identity.user.registered', { userId: uuidv7(), method: 'phone' }, { producer: 'identity' });

describeWithDatabase('Outbox et inbox SQL (PostgreSQL)', () => {
  const schema = `test_${Date.now()}`;
  let pool: Pool;
  let client: TransactionalSqlClient;

  beforeAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(readFileSync(MIGRATION, 'utf8'));
    client = transactional(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE outbox, processed_events');
  });

  it('publie les événements dans l’ordre puis les marque publiés', async () => {
    const first = envelope();
    const second = envelope();
    await client.$transaction(async (tx) => {
      await appendToOutbox(tx, first);
      await appendToOutbox(tx, second);
    });

    const seen: string[] = [];
    const store = new SqlOutboxStore(client);
    const count = await store.withUnpublishedBatch(10, async (records) => {
      seen.push(...records.map((record) => record.envelope.eventId));
      return records.map((record) => record.id);
    });

    expect(count).toBe(2);
    expect(seen).toEqual([first.eventId, second.eventId]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
    expect(rows[0].n).toBe(0);
  });

  it('compte une tentative sur le premier événement non publié', async () => {
    const failing = envelope();
    await client.$transaction((tx) => appendToOutbox(tx, failing));

    await new SqlOutboxStore(client).withUnpublishedBatch(10, async () => []);

    const { rows } = await pool.query('SELECT attempts, published_at FROM outbox WHERE id = $1', [
      failing.eventId,
    ]);
    expect(rows[0]).toMatchObject({ attempts: 1, published_at: null });
  });

  it('n’annule pas l’écriture métier si la publication échoue plus tard (l’événement reste en attente)', async () => {
    await client.$transaction((tx) => appendToOutbox(tx, envelope()));
    await expect(
      new SqlOutboxStore(client).withUnpublishedBatch(10, async () => {
        throw new Error('broker indisponible');
      }),
    ).rejects.toThrow('broker indisponible');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
    expect(rows[0].n).toBe(1);
  });

  it('deux relais en parallèle ne publient jamais le même événement (SKIP LOCKED)', async () => {
    await client.$transaction(async (tx) => {
      for (let i = 0; i < 6; i += 1) await appendToOutbox(tx, envelope());
    });
    const published: string[] = [];
    const relay = () =>
      new SqlOutboxStore(client).withUnpublishedBatch(3, async (records) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        published.push(...records.map((record) => record.id));
        return records.map((record) => record.id);
      });

    await Promise.all([relay(), relay()]);

    expect(published).toHaveLength(6);
    expect(new Set(published).size).toBe(6);
  });

  it('un événement reçu deux fois n’est traité qu’une fois', async () => {
    const inbox = new SqlInboxStore(client);
    const eventId = uuidv7();
    let effects = 0;
    const work = async () => {
      effects += 1;
    };

    await expect(inbox.runOnce(eventId, 'notification', work)).resolves.toBe('processed');
    await expect(inbox.runOnce(eventId, 'notification', work)).resolves.toBe('duplicate');
    await expect(inbox.runOnce(eventId, 'audit', work)).resolves.toBe('processed');
    expect(effects).toBe(2);
  });

  it('si le traitement échoue, l’événement pourra être retraité', async () => {
    const inbox = new SqlInboxStore(client);
    const eventId = uuidv7();
    await expect(
      inbox.runOnce(eventId, 'notification', async () => {
        throw new Error('échec');
      }),
    ).rejects.toThrow('échec');
    await expect(inbox.runOnce(eventId, 'notification', async () => undefined)).resolves.toBe('processed');
  });
});
