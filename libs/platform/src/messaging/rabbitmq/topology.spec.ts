import { type Channel } from 'amqplib';
import { assertConsumerTopology, consumerQueues } from './topology';

function fakeChannel() {
  return {
    assertExchange: jest.fn(async () => ({})),
    assertQueue: jest.fn(async () => ({})),
    bindQueue: jest.fn(async () => ({})),
  };
}

describe('assertConsumerTopology', () => {
  it('garde la file de reprise unique à délai fixe par défaut', async () => {
    const channel = fakeChannel();
    const queues = consumerQueues('notification', 'identity.user.registered');
    await assertConsumerTopology(channel as unknown as Channel, queues, 'identity.user.registered', [10_000]);
    const retry = channel.assertQueue.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('.retry'),
    );
    expect(retry).toEqual([
      [
        'notification.identity.user.registered.retry',
        expect.objectContaining({ arguments: expect.objectContaining({ 'x-message-ttl': 10_000 }) }),
      ],
    ]);
  });

  it('crée une file de reprise par délai, qui renvoie dans la file principale', async () => {
    const channel = fakeChannel();
    const queues = consumerQueues('billing', 'cleaning.request.cancelled', 2);
    await assertConsumerTopology(
      channel as unknown as Channel,
      queues,
      'cleaning.request.cancelled',
      [10_000, 30_000],
    );
    const retry = channel.assertQueue.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('.retry'),
    );
    expect(retry).toEqual([
      [
        'billing.cleaning.request.cancelled.retry.1',
        {
          durable: true,
          arguments: {
            'x-message-ttl': 10_000,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': 'billing.cleaning.request.cancelled',
          },
        },
      ],
      [
        'billing.cleaning.request.cancelled.retry.2',
        expect.objectContaining({ arguments: expect.objectContaining({ 'x-message-ttl': 30_000 }) }),
      ],
    ]);
  });
});
