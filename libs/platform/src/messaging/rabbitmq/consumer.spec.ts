import { type ConsumeMessage } from 'amqplib';
import { currentContext } from '../../context/request-context';
import { createEnvelope } from '../envelope';
import { handleDelivery } from './consumer';
import { consumerQueues } from './topology';

const queues = consumerQueues('notification', 'identity.user.registered');
const silentLogger = { warn: () => undefined, error: () => undefined };

function message(content: string, headers: Record<string, unknown> = {}): ConsumeMessage {
  return { content: Buffer.from(content), fields: {}, properties: { headers } } as unknown as ConsumeMessage;
}

function fakeChannel() {
  return { ack: jest.fn(), sendToQueue: jest.fn(() => true) };
}

const env = createEnvelope(
  'identity.user.registered',
  { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f', method: 'phone' },
  {
    producer: 'identity',
  },
);

describe('handleDelivery', () => {
  it('nomme les files selon la convention <consommateur>.<événement>', () => {
    expect(queues).toEqual({
      main: 'notification.identity.user.registered',
      retry: 'notification.identity.user.registered.retry',
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
      5,
      silentLogger,
    );
    expect(result).toBe('acked');
    expect(channel.ack).toHaveBeenCalledTimes(1);
    expect(seenContext).toEqual({ correlationId: env.correlationId, causationId: env.eventId });
  });

  it('renvoie en file de reprise avec le compteur de tentatives', async () => {
    const channel = fakeChannel();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env), { 'x-attempts': 2 }),
      async () => {
        throw new Error('base indisponible');
      },
      5,
      silentLogger,
    );
    expect(result).toBe('retried');
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      queues.retry,
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-attempts': 3 }) }),
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('un rejet sans valeur (undefined) part aussi en file de reprise', async () => {
    const channel = fakeChannel();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env)),
      () => Promise.reject(undefined),
      5,
      silentLogger,
    );
    expect(result).toBe('retried');
    expect(channel.sendToQueue).toHaveBeenCalledWith(
      queues.retry,
      expect.any(Buffer),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-last-error': 'undefined' }) }),
    );
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });

  it('envoie en file d’erreurs après le nombre maximum de tentatives', async () => {
    const channel = fakeChannel();
    const result = await handleDelivery(
      channel,
      queues,
      message(JSON.stringify(env), { 'x-attempts': 5 }),
      async () => {
        throw new Error('toujours en échec');
      },
      5,
      silentLogger,
    );
    expect(result).toBe('dead-lettered');
    expect(channel.sendToQueue).toHaveBeenCalledWith(queues.dlq, expect.any(Buffer), expect.anything());
  });

  it('délais croissants : une file de reprise par tentative, puis la file d’erreurs', async () => {
    const tiered = consumerQueues('billing', 'cleaning.request.cancelled', 3);
    expect(tiered.retryTiers).toEqual([
      'billing.cleaning.request.cancelled.retry.1',
      'billing.cleaning.request.cancelled.retry.2',
      'billing.cleaning.request.cancelled.retry.3',
    ]);
    const failing = async () => {
      throw new Error('contrat pas encore enregistré');
    };
    const channel = fakeChannel();
    await handleDelivery(channel, tiered, message(JSON.stringify(env)), failing, 3, silentLogger);
    await handleDelivery(
      channel,
      tiered,
      message(JSON.stringify(env), { 'x-attempts': 2 }),
      failing,
      3,
      silentLogger,
    );
    const last = await handleDelivery(
      channel,
      tiered,
      message(JSON.stringify(env), { 'x-attempts': 3 }),
      failing,
      3,
      silentLogger,
    );
    expect(channel.sendToQueue.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'billing.cleaning.request.cancelled.retry.1',
      'billing.cleaning.request.cancelled.retry.3',
      tiered.dlq,
    ]);
    expect(last).toBe('dead-lettered');
  });

  it('envoie directement en file d’erreurs un message illisible, sans appeler le gestionnaire', async () => {
    const channel = fakeChannel();
    const handler = jest.fn();
    const result = await handleDelivery(channel, queues, message('{pas du json'), handler, 5, silentLogger);
    expect(result).toBe('dead-lettered');
    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledTimes(1);
  });
});
