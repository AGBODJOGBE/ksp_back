import { type EventEnvelope } from '@ksp/contracts';
import { runWithContext } from '../context/request-context';
import { createEnvelope } from './envelope';
import { OutboxRelay } from './outbox-relay';
import { type EventPublisher, type OutboxRecord, type OutboxStore } from './ports';
import {
  appendToOutbox,
  type SqlExecutor,
  SqlInboxStore,
  SqlOutboxStore,
  type TransactionalSqlClient,
} from './sql-stores';

const envelope = (n: number): EventEnvelope =>
  createEnvelope(
    'identity.user.registered',
    { userId: `0192f1c4-7a2b-7c3d-8e4f-00000000000${n}`, method: 'phone' },
    {
      producer: 'identity',
    },
  );

/** Outbox en mémoire, avec la même sémantique que la version SQL. */
class InMemoryOutbox implements OutboxStore {
  readonly rows: (OutboxRecord & { published: boolean })[] = [];
  add(env: EventEnvelope) {
    this.rows.push({ id: env.eventId, envelope: env, attempts: 0, published: false });
  }
  async withUnpublishedBatch(limit: number, publish: (records: OutboxRecord[]) => Promise<string[]>) {
    const batch = this.rows.filter((row) => !row.published).slice(0, limit);
    const ids = await publish(batch);
    for (const row of this.rows) if (ids.includes(row.id)) row.published = true;
    return ids.length;
  }
}

class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];
  failOn?: string;
  async publish(env: EventEnvelope) {
    if (env.eventId === this.failOn) throw new Error('broker indisponible');
    this.published.push(env.eventId);
  }
}

describe('enveloppe', () => {
  it('reprend la corrélation et la causalité du contexte courant', () => {
    const env = runWithContext({ correlationId: 'corr-1', causationId: 'evt-0' }, () => envelope(1));
    expect(env).toMatchObject({
      type: 'identity.user.registered',
      version: 1,
      correlationId: 'corr-1',
      causationId: 'evt-0',
    });
    expect(env.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });
});

describe('OutboxRelay', () => {
  it('publie dans l’ordre et marque les événements publiés', async () => {
    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const events = [envelope(1), envelope(2), envelope(3)];
    events.forEach((e) => outbox.add(e));
    await expect(new OutboxRelay(outbox, publisher).runOnce()).resolves.toBe(3);
    expect(publisher.published).toEqual(events.map((e) => e.eventId));
    expect(outbox.rows.every((row) => row.published)).toBe(true);
  });

  it('s’arrête au premier échec pour préserver l’ordre, et reprend au passage suivant', async () => {
    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const events = [envelope(1), envelope(2), envelope(3)];
    events.forEach((e) => outbox.add(e));
    publisher.failOn = events[1]!.eventId;
    const relay = new OutboxRelay(outbox, publisher);
    await expect(relay.runOnce()).resolves.toBe(1);
    expect(publisher.published).toEqual([events[0]!.eventId]);
    publisher.failOn = undefined;
    await expect(relay.runOnce()).resolves.toBe(2);
    expect(publisher.published).toEqual(events.map((e) => e.eventId));
  });

  it('tourne en tâche de fond et s’arrête proprement', async () => {
    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay(outbox, publisher, { idleDelayMs: 5 });
    relay.start();
    outbox.add(envelope(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await relay.stop();
    expect(publisher.published).toHaveLength(1);
  });
});

/** Faux client SQL qui enregistre les requêtes et renvoie des réponses programmées. */
function fakeSqlClient(responses: { query?: unknown[]; execute?: number[] }) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const executor: SqlExecutor = {
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]) {
      calls.push({ sql, values });
      return (responses.query?.shift() ?? []) as T;
    },
    async $executeRawUnsafe(sql: string, ...values: unknown[]) {
      calls.push({ sql, values });
      return responses.execute?.shift() ?? 1;
    },
  };
  const client: TransactionalSqlClient = { ...executor, $transaction: (fn) => fn(executor) };
  return { client, calls };
}

describe('stores SQL', () => {
  it('écrit l’événement complet dans l’outbox', async () => {
    const { client, calls } = fakeSqlClient({});
    const env = envelope(1);
    await appendToOutbox(client, env);
    expect(calls[0]!.sql).toContain('INSERT INTO outbox');
    expect(calls[0]!.values).toEqual([env.eventId, env.type, JSON.stringify(env)]);
  });

  it('verrouille un lot sans bloquer les autres instances, puis marque les publiés', async () => {
    const env1 = envelope(1);
    const env2 = envelope(2);
    const { client, calls } = fakeSqlClient({
      query: [
        [
          { id: env1.eventId, payload: env1, attempts: 0 },
          { id: env2.eventId, payload: JSON.stringify(env2), attempts: 2 },
        ],
      ],
    });
    const count = await new SqlOutboxStore(client).withUnpublishedBatch(10, async (records) => {
      expect(records.map((r) => r.envelope.eventId)).toEqual([env1.eventId, env2.eventId]);
      return [env1.eventId];
    });
    expect(count).toBe(1);
    expect(calls[0]!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls[1]).toEqual({ sql: expect.stringContaining('SET published_at'), values: [[env1.eventId]] });
    expect(calls[2]).toEqual({
      sql: expect.stringContaining('attempts = attempts + 1'),
      values: [env2.eventId],
    });
  });

  it('ne traite pas deux fois le même événement', async () => {
    const work = jest.fn(async () => undefined);
    const first = fakeSqlClient({ execute: [1] });
    await expect(new SqlInboxStore(first.client).runOnce('evt-1', 'notification', work)).resolves.toBe(
      'processed',
    );
    const second = fakeSqlClient({ execute: [0] });
    await expect(new SqlInboxStore(second.client).runOnce('evt-1', 'notification', work)).resolves.toBe(
      'duplicate',
    );
    expect(work).toHaveBeenCalledTimes(1);
  });
});
