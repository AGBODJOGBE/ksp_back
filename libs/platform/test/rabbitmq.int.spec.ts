import { type EventEnvelope } from '@ksp/contracts';
import { type ConfirmChannel } from 'amqplib';
import { createEnvelope } from '../src/messaging/envelope';
import { RabbitMqConnection } from '../src/messaging/rabbitmq/connection';
import { RabbitMqConsumer } from '../src/messaging/rabbitmq/consumer';
import { RabbitMqPublisher } from '../src/messaging/rabbitmq/publisher';
import { consumerQueues, EVENTS_EXCHANGE } from '../src/messaging/rabbitmq/topology';

/**
 * Tests d'intégration contre un vrai RabbitMQ (ADR-047) : abonnement rétabli, publication
 * « mandatory », file d'erreurs, émetteur vérifié. Ignorés si TEST_RABBITMQ_URL n'est pas défini
 * (la CI le fournit).
 */
const rabbitMqUrl = process.env.TEST_RABBITMQ_URL;
const describeWithBroker = rabbitMqUrl ? describe : describe.skip;

jest.setTimeout(30_000);

const RETRY_DELAYS_MS = [200, 200];

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition jamais remplie');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const deleted = () =>
  createEnvelope(
    'identity.user.deleted',
    { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f' },
    { producer: 'identity' },
  );

describeWithBroker('Messagerie RabbitMQ (broker réel)', () => {
  const run = `it${Date.now()}`;
  const queues: string[] = [];
  let connection: RabbitMqConnection;
  let admin: ConfirmChannel;
  let consumers: RabbitMqConsumer[] = [];

  const consumerName = (name: string) => `${run}-${name}`;
  const consumer = (name: string, extra: object = {}) => {
    const created = new RabbitMqConsumer(connection, {
      consumer: consumerName(name),
      retryDelaysMs: RETRY_DELAYS_MS,
      resubscribeDelayMs: 100,
      ...extra,
    });
    consumers.push(created);
    const all = consumerQueues(consumerName(name), 'identity.user.deleted', RETRY_DELAYS_MS);
    queues.push(all.main, all.dlq, ...all.retry);
    return created;
  };
  const depth = async (queue: string) => (await admin.checkQueue(queue)).messageCount;

  beforeAll(async () => {
    connection = new RabbitMqConnection(rabbitMqUrl as string);
    admin = await connection.consumerChannel(1);
  });

  afterEach(async () => {
    await Promise.all(consumers.map((created) => created.close()));
    consumers = [];
  });

  afterAll(async () => {
    for (const queue of queues) await admin.deleteQueue(queue).catch(() => undefined);
    await connection.close();
  });

  it('rétablit un abonnement dont le canal a été fermé par le broker', async () => {
    const received: string[] = [];
    const channels: ConfirmChannel[] = [];
    const spy = jest.spyOn(connection, 'consumerChannel');
    spy.mockImplementation(async (prefetch) => {
      const channel = await RabbitMqConnection.prototype.consumerChannel.call(connection, prefetch);
      channels.push(channel);
      return channel;
    });
    try {
      await consumer('resubscribe').subscribe('identity.user.deleted', async (envelope) => {
        received.push(envelope.eventId);
      });
      // Erreur de canal (file inconnue) : le broker ferme le canal du consommateur.
      channels[0].on('error', () => undefined);
      await channels[0].checkQueue(`${run}-absente`).catch(() => undefined);
      await eventually(() => channels.length === 2);

      const event = deleted();
      await new RabbitMqPublisher(connection).publish(event);
      await eventually(() => received.includes(event.eventId));
    } finally {
      spy.mockRestore();
    }
  });

  it('publication non routée d’un événement attendu par un consommateur : échec (l’outbox réessaie)', async () => {
    // Aucune file n'est liée à `payment.intent.succeeded` sur un exchange de test : non routé.
    const publisher = new RabbitMqPublisher(connection, { exchange: `${run}.events` });
    const event = createEnvelope(
      'payment.intent.succeeded',
      {} as never, // le contenu n'est pas lu par le publieur
      { producer: 'payment' },
    );
    await expect(publisher.publish(event)).rejects.toThrow(/non routé/);
    await admin.deleteExchange(`${run}.events`).catch(() => undefined);
  });

  it('redéclare l’exchange sur un nouveau canal de publication', async () => {
    const exchange = `${run}.redeclared`;
    const publisher = new RabbitMqPublisher(connection, { exchange });
    // Événement que personne n'attend : non routé sur cet exchange de test, sans erreur.
    const verified = () =>
      createEnvelope('identity.user.verified', { userId: deleted().payload.userId } as never, {
        producer: 'identity',
      });
    await publisher.publish(verified());
    await admin.deleteExchange(exchange);
    // Nouveau canal de publication (le précédent est fermé, comme après une reconnexion).
    await (await connection.confirmChannel()).close();
    await expect(publisher.publish(verified())).resolves.toBeUndefined();
    await admin.deleteExchange(exchange).catch(() => undefined);
  });

  it('après toutes les tentatives, le message est en file d’erreurs', async () => {
    const created = consumer('dlq');
    let calls = 0;
    await created.subscribe('identity.user.deleted', async () => {
      calls += 1;
      throw new Error('toujours en échec');
    });
    const { dlq } = consumerQueues(consumerName('dlq'), 'identity.user.deleted');
    await new RabbitMqPublisher(connection).publish(deleted());
    await eventually(async () => (await depth(dlq)) === 1);
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
  });

  it('refuse vers la file d’erreurs un événement publié par un autre service que son propriétaire', async () => {
    const created = consumer('producer');
    const handler = jest.fn(async (_envelope: EventEnvelope) => undefined);
    await created.subscribe('identity.user.deleted', handler);
    const { dlq } = consumerQueues(consumerName('producer'), 'identity.user.deleted');
    const forged = { ...deleted(), producer: 'payment' };
    await new RabbitMqPublisher(connection).publish(forged);
    await eventually(async () => (await depth(dlq)) === 1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('un message qui fait tomber le consommateur à chaque remise finit en file d’erreurs', async () => {
    const channels: ConfirmChannel[] = [];
    const spy = jest.spyOn(connection, 'consumerChannel');
    spy.mockImplementation(async (prefetch) => {
      const channel = await RabbitMqConnection.prototype.consumerChannel.call(connection, prefetch);
      channel.on('error', () => undefined);
      channels.push(channel);
      return channel;
    });
    try {
      const created = consumer('poison', { maxRedeliveries: 2 });
      const handler = jest.fn(async () => {
        // Panne en plein traitement : le canal tombe sans acquittement, le message est remis.
        await channels
          .at(-1)
          ?.checkQueue(`${run}-absente`)
          .catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      });
      await created.subscribe('identity.user.deleted', handler);
      const { dlq } = consumerQueues(consumerName('poison'), 'identity.user.deleted');
      await new RabbitMqPublisher(connection).publish(deleted());
      await eventually(async () => (await depth(dlq)) === 1, 20_000);
      // Première livraison, puis une remise ; la deuxième remise part en file d'erreurs.
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('la topologie déclarée est faite de files quorum', async () => {
    await consumer('quorum').subscribe('identity.user.deleted', async () => undefined);
    const all = consumerQueues(consumerName('quorum'), 'identity.user.deleted', RETRY_DELAYS_MS);
    expect(all.retry).toEqual([`${all.main}.retry.200ms`, `${all.main}.retry.200ms`]);
    // Redéclarer une file quorum comme classique (mêmes arguments sinon) échoue : preuve de son type.
    const declared: [string, Record<string, unknown>][] = [
      [all.main, {}],
      [
        all.retry[0],
        {
          'x-message-ttl': 200,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': all.main,
          'x-dead-letter-strategy': 'at-least-once',
          'x-overflow': 'reject-publish',
        },
      ],
      [all.dlq, {}],
    ];
    for (const [queue, args] of declared) {
      const probe = await connection.consumerChannel(1);
      probe.on('error', () => undefined);
      await expect(
        probe.assertQueue(queue, { durable: true, arguments: { ...args, 'x-queue-type': 'classic' } }),
      ).rejects.toThrow(/x-queue-type/);
    }
    expect(EVENTS_EXCHANGE).toBe('ksp.events');
  });
});
