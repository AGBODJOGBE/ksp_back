import { EventEmitter } from 'node:events';
import { type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { currentContext } from '../../context/request-context';
import { createEnvelope } from '../envelope';
import { type RabbitMqConnection } from './connection';
import { type DeliveryOptions, handleDelivery, RabbitMqConsumer } from './consumer';
import { consumerQueues } from './topology';

const DELAYS = [10_000, 30_000, 60_000];
const queues = consumerQueues('notification', 'identity.user.registered', DELAYS);
const silentLogger = { warn: () => undefined, error: () => undefined, log: () => undefined };
const options: DeliveryOptions = { versions: [1], maxRedeliveries: 10 };

function message(content: string, headers: Record<string, unknown> = {}): ConsumeMessage {
  return { content: Buffer.from(content), fields: {}, properties: { headers } } as unknown as ConsumeMessage;
}

/** Canal factice : chaque copie est confirmée (ou refusée si `nackCopies`). */
function fakeChannel(nackCopies = false) {
  return {
    ack: jest.fn(),
    nack: jest.fn(),
    sendToQueue: jest.fn(
      (_queue: string, _content: Buffer, _options: unknown, confirmed?: (error: unknown) => void) => {
        setImmediate(() => confirmed?.(nackCopies ? new Error('message refusé par le broker') : null));
        return true;
      },
    ),
  };
}

const env = createEnvelope(
  'identity.user.registered',
  { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f', method: 'phone' },
  { producer: 'identity' },
);
const failing = async () => {
  throw new Error('base indisponible');
};

describe('handleDelivery', () => {
  it('nomme les files selon la convention <consommateur>.<événement>, une file de reprise par délai', () => {
    expect(queues).toEqual({
      main: 'notification.identity.user.registered',
      retry: [
        'notification.identity.user.registered.retry.10s',
        'notification.identity.user.registered.retry.30s',
        'notification.identity.user.registered.retry.1m',
      ],
      dlq: 'notification.identity.user.registered.dlq',
    });
  });

  it('acquitte après un traitement réussi, dans le contexte de l’événement', async () => {
    const channel = fakeChannel();
    let seenContext: unknown;
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env)),
      async () => {
        seenContext = currentContext();
      },
      options,
      silentLogger,
    );
    expect(result).toBe('acked');
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(seenContext).toEqual({ correlationId: env.correlationId, causationId: env.eventId });
  });

  it('renvoie dans la file de reprise de la tentative, avec le compteur', async () => {
    const channel = fakeChannel();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env), { 'x-attempts': 1 }),
      failing,
      options,
      silentLogger,
    );
    expect(result).toBe('retried');
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      queues.retry[1],
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-attempts': 2 }) }),
      expect.any(Function),
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('n’acquitte pas une copie que le broker ne confirme pas : le message est rendu à sa file', async () => {
    const channel = fakeChannel(true);
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env)),
      failing,
      options,
      silentLogger,
    );
    expect(result).toBe('requeued');
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(expect.anything(), false, true);
  });

  it('attend la confirmation de la copie avant d’acquitter', async () => {
    const order: string[] = [];
    const channel = {
      ack: jest.fn(() => void order.push('ack')),
      nack: jest.fn(),
      sendToQueue: jest.fn((_q: string, _c: Buffer, _o: unknown, confirmed: (error: unknown) => void) => {
        setImmediate(() => {
          order.push('confirm');
          confirmed(null);
        });
        return true;
      }),
    };
    await handleDelivery(channel, queues, message(JSON.stringify(env)), failing, options, silentLogger);
    expect(order).toEqual(['confirm', 'ack']);
  });

  it('un rejet sans valeur (undefined) part aussi en file de reprise', async () => {
    const channel = fakeChannel();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env)),
      () => Promise.reject(undefined),
      options,
      silentLogger,
    );
    expect(result).toBe('retried');
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      queues.retry[0],
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-last-error': 'undefined' }) }),
      expect.any(Function),
    );
  });

  it('envoie en file d’erreurs après la dernière tentative', async () => {
    const channel = fakeChannel();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env), { 'x-attempts': DELAYS.length }),
      failing,
      options,
      silentLogger,
    );
    expect(result).toBe('dead-lettered');
    expect(channel.sendToQueue.mock.calls[0][0]).toBe(queues.dlq);
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('envoie directement en file d’erreurs un message illisible, sans appeler le gestionnaire', async () => {
    const channel = fakeChannel();
    const handler = jest.fn();
    const result = await handleDelivery(
      channel,
      queues,
      message('{pas du json'),
      handler,
      options,
      silentLogger,
    );
    expect(result).toBe('dead-lettered');
    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['un émetteur autre que le propriétaire du type', { ...env, producer: 'payment' }, 'unexpected_producer'],
    ['une version inconnue', { ...env, version: 2 }, 'unsupported_version'],
  ])('refuse vers la file d’erreurs %s, sans appeler le gestionnaire', async (_case, forged, reason) => {
    const channel = fakeChannel();
    const handler = jest.fn();
    const errors: string[] = [];
    const result = await handleDelivery(channel, queues, message(JSON.stringify(forged)), handler, options, {
      warn: () => undefined,
      error: (text: string) => void errors.push(text),
    });
    expect(result).toBe('dead-lettered');
    expect(handler).not.toHaveBeenCalled();
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      queues.dlq,
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-failure-reason': reason }) }),
      expect.any(Function),
    );
    expect(errors[0]).toMatch(/^ALERTE messagerie/);
  });

  it('accepte une autre version si le gestionnaire la déclare', async () => {
    const channel = fakeChannel();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify({ ...env, version: 2 })),
      async () => undefined,
      { ...options, versions: [1, 2] },
      silentLogger,
    );
    expect(result).toBe('acked');
  });

  it('un message remis trop de fois sans acquittement part en file d’erreurs sans être traité', async () => {
    const channel = fakeChannel();
    const handler = jest.fn();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env), { 'x-delivery-count': 10 }),
      handler,
      options,
      silentLogger,
    );
    expect(result).toBe('dead-lettered');
    expect(handler).not.toHaveBeenCalled();
  });
});

/** Connexion factice : chaque canal est un émetteur d'événements, comme ceux d'amqplib. */
function fakeConnection() {
  const channels: (EventEmitter & Record<string, jest.Mock>)[] = [];
  const connection = {
    closed: false,
    consumerChannel: jest.fn(async () => {
      const channel = Object.assign(new EventEmitter(), {
        assertExchange: jest.fn(async () => ({})),
        assertQueue: jest.fn(async () => ({})),
        bindQueue: jest.fn(async () => ({})),
        consume: jest.fn(async () => ({ consumerTag: 'tag' })),
        close: jest.fn(async function (this: EventEmitter) {
          this.emit('close');
        }),
      });
      channels.push(channel as never);
      return channel as unknown as ConfirmChannel;
    }),
  };
  return { connection, channels };
}

describe('RabbitMqConsumer', () => {
  const create = (connection: object) =>
    new RabbitMqConsumer(connection as unknown as RabbitMqConnection, {
      consumer: 'notification',
      resubscribeDelayMs: 5,
    });

  it('rétablit un abonnement dont le canal est fermé (broker redémarré, erreur de canal)', async () => {
    const { connection, channels } = fakeConnection();
    const consumer = create(connection);
    await consumer.subscribe('identity.user.deleted', async () => undefined);
    channels[0].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(channels).toHaveLength(2);
    expect(channels[1].consume).toHaveBeenCalledWith(
      'notification.identity.user.deleted',
      expect.any(Function),
    );
    await consumer.close();
  });

  it('réessaie avec un délai croissant tant que le broker est indisponible', async () => {
    const { connection, channels } = fakeConnection();
    const consumer = create(connection);
    await consumer.subscribe('identity.user.deleted', async () => undefined);
    const open = connection.consumerChannel.getMockImplementation()!;
    connection.consumerChannel.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    connection.consumerChannel.mockImplementation(open);
    channels[0].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(connection.consumerChannel).toHaveBeenCalledTimes(3);
    expect(channels).toHaveLength(2);
    await consumer.close();
  });

  it('ne rétablit rien après sa fermeture ou celle de la connexion', async () => {
    const { connection, channels } = fakeConnection();
    const consumer = create(connection);
    await consumer.subscribe('identity.user.deleted', async () => undefined);
    await consumer.close();
    const other = create(connection);
    await other.subscribe('identity.user.deleted', async () => undefined);
    connection.closed = true;
    channels[1].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(channels).toHaveLength(2);
  });

  it('applique les délais croissants par défaut (10 s à 30 min)', async () => {
    const { connection, channels } = fakeConnection();
    const consumer = create(connection);
    await consumer.subscribe('identity.user.deleted', async () => undefined);
    const retry = channels[0].assertQueue.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((name: string) => name.includes('.retry.'));
    expect(retry.map((name: string) => name.split('.retry.')[1])).toEqual([
      '10s',
      '30s',
      '1m',
      '2m',
      '5m',
      '10m',
      '15m',
      '30m',
    ]);
    await consumer.close();
  });
});
