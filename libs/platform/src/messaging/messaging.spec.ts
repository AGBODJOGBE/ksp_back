import { type EventEnvelope } from '@ksp/contracts';
import { Logger } from '@nestjs/common';
import { runWithContext } from '../context/request-context';
import { createEnvelope } from './envelope';
import { OutboxRelay, outboxRetryDelayMs } from './outbox-relay';
import { type EventPublisher, type OutboxBatchResult, type OutboxRecord, type OutboxStore } from './ports';
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

/** Outbox en mémoire, avec la même sémantique que la version SQL (délai simulé par une horloge). */
class InMemoryOutbox implements OutboxStore {
  readonly rows: (OutboxRecord & {
    published: boolean;
    parked: boolean;
    nextAttemptAt: number;
    lastError: string | null;
  })[] = [];
  now = 0;
  add(env: EventEnvelope) {
    this.rows.push({
      id: env.eventId,
      envelope: env,
      attempts: 0,
      published: false,
      parked: false,
      nextAttemptAt: 0,
      lastError: null,
    });
  }
  row(id: string) {
    return this.rows.find((row) => row.id === id)!;
  }
  async withUnpublishedBatch(
    limit: number,
    publish: (records: OutboxRecord[]) => Promise<OutboxBatchResult>,
  ) {
    const batch = this.rows
      .filter((row) => !row.published && !row.parked && row.nextAttemptAt <= this.now)
      .slice(0, limit);
    if (batch.length === 0) return 0;
    const { published, failed } = await publish(
      batch.map(({ id, envelope, attempts }) => ({ id, envelope, attempts })),
    );
    for (const row of this.rows) if (published.includes(row.id)) row.published = true;
    for (const failure of failed) {
      const row = this.row(failure.id);
      row.attempts += 1;
      row.lastError = failure.error;
      if (failure.retryInMs === null) row.parked = true;
      else row.nextAttemptAt = this.now + failure.retryInMs;
    }
    return published.length;
  }
}

class RecordingPublisher implements EventPublisher {
  readonly published: string[] = [];
  readonly failing = new Set<string>();
  down = false;
  set failOn(id: string | undefined) {
    this.failing.clear();
    if (id) this.failing.add(id);
  }
  async publish(env: EventEnvelope) {
    if (this.down) throw new Error('connect ECONNREFUSED');
    if (this.failing.has(env.eventId)) throw new Error('read ECONNRESET');
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

  it('un événement en échec ne bloque pas les suivants ; il est réessayé après son délai', async () => {
    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const events = [envelope(1), envelope(2), envelope(3)];
    events.forEach((e) => outbox.add(e));
    publisher.failOn = events[0]!.eventId;
    const relay = new OutboxRelay(outbox, publisher);
    await expect(relay.runOnce()).resolves.toBe(2);
    expect(publisher.published).toEqual([events[1]!.eventId, events[2]!.eventId]);
    expect(outbox.row(events[0]!.eventId)).toMatchObject({
      attempts: 1,
      published: false,
      nextAttemptAt: 1000,
      lastError: 'read ECONNRESET',
    });
    // Avant son délai, l'événement en échec n'est pas repris.
    publisher.failOn = undefined;
    outbox.now = 999;
    await expect(relay.runOnce()).resolves.toBe(0);
    outbox.now = 1000;
    await expect(relay.runOnce()).resolves.toBe(1);
    expect(publisher.published).toEqual([events[1]!.eventId, events[2]!.eventId, events[0]!.eventId]);
  });

  it('deux événements en échec à la suite ne bloquent pas non plus les suivants', async () => {
    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const events = [envelope(1), envelope(2), envelope(3)];
    events.forEach((e) => outbox.add(e));
    publisher.failing.add(events[0]!.eventId).add(events[1]!.eventId);
    const relay = new OutboxRelay(outbox, publisher);
    // Deux échecs de suite : passage interrompu, seul le premier est compté.
    await expect(relay.runOnce()).resolves.toBe(0);
    expect(outbox.row(events[0]!.eventId).attempts).toBe(1);
    expect(outbox.row(events[1]!.eventId).attempts).toBe(0);
    // Passage suivant : le premier attend son délai, le second échoue seul, le troisième part.
    await expect(relay.runOnce()).resolves.toBe(1);
    expect(publisher.published).toEqual([events[2]!.eventId]);
    expect(outbox.row(events[1]!.eventId).attempts).toBe(1);
  });

  it('broker indisponible : le passage s’arrête au deuxième échec, sans user les tentatives', async () => {
    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const events = [envelope(1), envelope(2), envelope(3), envelope(4)];
    events.forEach((e) => outbox.add(e));
    publisher.down = true;
    await expect(new OutboxRelay(outbox, publisher).runOnce()).resolves.toBe(0);
    expect(outbox.rows.map((row) => row.attempts)).toEqual([1, 0, 0, 0]);
  });

  it('délai croissant entre les tentatives d’un événement, plafonné', async () => {
    expect([1, 2, 3, 4, 5].map((n) => outboxRetryDelayMs(n))).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(outboxRetryDelayMs(12)).toBe(5 * 60_000);
    expect(outboxRetryDelayMs(500)).toBe(5 * 60_000);
    expect(outboxRetryDelayMs(3, { retryBaseDelayMs: 10, retryMaxDelayMs: 30 })).toBe(30);

    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const event = envelope(1);
    outbox.add(event);
    publisher.failOn = event.eventId;
    const relay = new OutboxRelay(outbox, publisher);
    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      outbox.now = outbox.row(event.eventId).nextAttemptAt;
      const before = outbox.now;
      await relay.runOnce();
      delays.push(outbox.row(event.eventId).nextAttemptAt - before);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it('au-delà de la limite, l’événement est mis de côté (alerte) et n’est plus repris', async () => {
    const outbox = new InMemoryOutbox();
    const publisher = new RecordingPublisher();
    const event = envelope(1);
    outbox.add(event);
    publisher.failOn = event.eventId;
    const relay = new OutboxRelay(outbox, publisher, { maxAttempts: 3, retryBaseDelayMs: 1 });
    const alerts = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 3; i += 1) {
        outbox.now += 1000;
        await relay.runOnce();
      }
      expect(outbox.row(event.eventId)).toMatchObject({ attempts: 3, parked: true, published: false });
      expect(alerts).toHaveBeenCalledWith(expect.stringContaining('mis de côté après 3 tentatives'));
      // Mis de côté : plus repris, même la cause corrigée, tant qu'il n'est pas rejoué.
      publisher.failOn = undefined;
      outbox.now += 3_600_000;
      await expect(relay.runOnce()).resolves.toBe(0);
    } finally {
      alerts.mockRestore();
    }
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

  it('verrouille un lot sans bloquer les autres instances, marque les publiés et enregistre les échecs', async () => {
    const env1 = envelope(1);
    const env2 = envelope(2);
    const env3 = envelope(3);
    const { client, calls } = fakeSqlClient({
      query: [
        [
          { id: env1.eventId, payload: env1, attempts: 0 },
          { id: env2.eventId, payload: JSON.stringify(env2), attempts: 2 },
          { id: env3.eventId, payload: env3, attempts: 24 },
        ],
      ],
    });
    const count = await new SqlOutboxStore(client).withUnpublishedBatch(10, async (records) => {
      expect(records.map((r) => r.envelope.eventId)).toEqual([env1.eventId, env2.eventId, env3.eventId]);
      return {
        published: [env1.eventId],
        failed: [
          { id: env2.eventId, error: 'read ECONNRESET', retryInMs: 4000 },
          { id: env3.eventId, error: 'read ECONNRESET', retryInMs: null },
        ],
      };
    });
    expect(count).toBe(1);
    expect(calls[0]!.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(calls[0]!.sql).toContain('parked_at IS NULL');
    expect(calls[0]!.sql).toContain('next_attempt_at <= now()');
    expect(calls[1]).toEqual({ sql: expect.stringContaining('SET published_at'), values: [[env1.eventId]] });
    expect(calls[2]).toEqual({
      sql: expect.stringContaining('next_attempt_at = now() +'),
      values: [env2.eventId, 4000, 'read ECONNRESET'],
    });
    expect(calls[3]).toEqual({
      sql: expect.stringContaining('parked_at = now()'),
      values: [env3.eventId, 'read ECONNRESET'],
    });
  });

  it('rejoue les événements mis de côté', async () => {
    const { client, calls } = fakeSqlClient({ execute: [2, 1] });
    await expect(new SqlOutboxStore(client).replayParked()).resolves.toBe(2);
    await expect(new SqlOutboxStore(client).replayParked(['evt-1'])).resolves.toBe(1);
    expect(calls[0]!.sql).toContain('SET parked_at = NULL, attempts = 0');
    expect(calls[0]!.values).toEqual([]);
    expect(calls[1]!.values).toEqual([['evt-1']]);
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
