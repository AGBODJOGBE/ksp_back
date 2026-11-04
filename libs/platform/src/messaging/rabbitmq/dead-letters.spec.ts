import { type GetMessage } from 'amqplib';
import { type DeadLetterChannel, replayDeadLetters } from './dead-letters';
import { consumerQueues } from './topology';

const queues = consumerQueues('billing', 'cleaning.request.cancelled');

function deadLetter(content: string): GetMessage {
  return {
    content: Buffer.from(content),
    fields: {},
    properties: {
      messageId: content,
      headers: {
        'x-attempts': 5,
        'x-last-error': 'contrat inconnu',
        'x-failure-reason': 'contrat inconnu',
        other: 1,
      },
    },
  } as unknown as GetMessage;
}

function fakeChannel(messages: GetMessage[]) {
  const pending = [...messages];
  return {
    checkQueue: jest.fn(async () => ({ queue: queues.dlq, messageCount: messages.length, consumerCount: 0 })),
    get: jest.fn(async () => pending.shift() ?? false),
    sendToQueue: jest.fn(() => true),
    waitForConfirms: jest.fn(async () => undefined),
    ack: jest.fn(),
  };
}

describe('replayDeadLetters', () => {
  it('republie dans la file principale sans les en-têtes d’échec, puis retire de la file d’erreurs', async () => {
    const channel = fakeChannel([deadLetter('a'), deadLetter('b')]);
    const count = await replayDeadLetters(channel as unknown as DeadLetterChannel, queues);
    expect(count).toBe(2);
    expect(channel.get).toHaveBeenCalledWith(queues.dlq, { noAck: false });
    const [queue, content, options] = channel.sendToQueue.mock.calls[0] as unknown as [
      string,
      Buffer,
      { messageId: string; headers: Record<string, unknown> },
    ];
    expect(queue).toBe(queues.main);
    expect(content.toString()).toBe('a');
    expect(options.messageId).toBe('a');
    expect(options.headers).toEqual({ other: 1, 'x-replayed-at': expect.any(String) });
    expect(channel.ack).toHaveBeenCalledTimes(2);
  });

  it('n’acquitte pas un message dont la republication n’est pas confirmée', async () => {
    const channel = fakeChannel([deadLetter('a')]);
    channel.waitForConfirms.mockRejectedValueOnce(new Error('canal fermé'));
    await expect(replayDeadLetters(channel as unknown as DeadLetterChannel, queues)).rejects.toThrow(
      'canal fermé',
    );
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it('ne reprend que les messages présents au départ', async () => {
    const channel = fakeChannel([deadLetter('a')]);
    channel.get.mockImplementation(async () => deadLetter('toujours'));
    expect(await replayDeadLetters(channel as unknown as DeadLetterChannel, queues)).toBe(1);
    expect(channel.get).toHaveBeenCalledTimes(1);
  });
});
