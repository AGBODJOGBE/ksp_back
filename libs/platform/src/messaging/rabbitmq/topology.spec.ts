import { type Channel } from 'amqplib';
import { assertConsumerTopology, consumerQueues, delayLabel } from './topology';

function fakeChannel() {
  return {
    assertExchange: jest.fn(async () => ({})),
    assertQueue: jest.fn(async () => ({})),
    bindQueue: jest.fn(async () => ({})),
  };
}

describe('assertConsumerTopology', () => {
  it('nomme chaque file de reprise par son délai', () => {
    expect([10_000, 90_000, 120_000, 3_600_000, 1_500].map(delayLabel)).toEqual([
      '10s',
      '90s',
      '2m',
      '1h',
      '1500ms',
    ]);
  });

  it('déclare des files quorum : principale, une de reprise par délai (renvoi au moins une fois), erreurs', async () => {
    const channel = fakeChannel();
    const queues = consumerQueues('billing', 'cleaning.request.cancelled', [10_000, 30_000]);
    await assertConsumerTopology(
      channel as unknown as Channel,
      queues,
      'cleaning.request.cancelled',
      [10_000, 30_000],
    );
    expect(channel.assertQueue.mock.calls).toEqual([
      ['billing.cleaning.request.cancelled', { durable: true, arguments: { 'x-queue-type': 'quorum' } }],
      [
        'billing.cleaning.request.cancelled.retry.10s',
        {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-message-ttl': 10_000,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': 'billing.cleaning.request.cancelled',
            'x-dead-letter-strategy': 'at-least-once',
            'x-overflow': 'reject-publish',
          },
        },
      ],
      [
        'billing.cleaning.request.cancelled.retry.30s',
        expect.objectContaining({ arguments: expect.objectContaining({ 'x-message-ttl': 30_000 }) }),
      ],
      ['billing.cleaning.request.cancelled.dlq', { durable: true, arguments: { 'x-queue-type': 'quorum' } }],
    ]);
    expect(channel.bindQueue).toHaveBeenCalledWith(
      'billing.cleaning.request.cancelled',
      'ksp.events',
      'cleaning.request.cancelled',
    );
  });
});
