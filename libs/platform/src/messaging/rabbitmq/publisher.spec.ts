import { EventEmitter } from 'node:events';
import { createEnvelope } from '../envelope';
import { type RabbitMqConnection } from './connection';
import { RabbitMqPublisher } from './publisher';

/** Canal de publication factice : `unroutable` simule un message renvoyé par le broker (aucune file). */
function fakeChannel(unroutable = false) {
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: jest.fn(async () => ({})),
    publish: jest.fn((_exchange: string, _key: string, _content: Buffer, options: { messageId: string }) => {
      if (unroutable) channel.emit('return', { properties: { messageId: options.messageId } });
      return true;
    }),
    waitForConfirms: jest.fn(async () => undefined),
  });
  return channel;
}

function publisherOn(...channels: ReturnType<typeof fakeChannel>[]) {
  const connection = { confirmChannel: jest.fn() };
  for (const channel of channels) connection.confirmChannel.mockResolvedValueOnce(channel);
  return new RabbitMqPublisher(connection as unknown as RabbitMqConnection);
}

const succeeded = () =>
  createEnvelope(
    'identity.user.deleted',
    { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f' },
    {
      producer: 'identity',
    },
  );

describe('RabbitMqPublisher', () => {
  it('publie en « mandatory », persistant', async () => {
    const channel = fakeChannel();
    await publisherOn(channel).publish(succeeded());
    expect(channel.publish).toHaveBeenCalledWith(
      'ksp.events',
      'identity.user.deleted',
      expect.any(Buffer),
      expect.objectContaining({ mandatory: true, persistent: true }),
    );
  });

  it('un événement attendu par un consommateur et non routé est un échec (l’outbox réessaie)', async () => {
    await expect(publisherOn(fakeChannel(true)).publish(succeeded())).rejects.toThrow(/non routé/);
  });

  it('un événement que personne n’attend, non routé, est abandonné sans erreur', async () => {
    const otp = createEnvelope(
      'identity.user.verified',
      { userId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f' } as never,
      {
        producer: 'identity',
      },
    );
    await expect(publisherOn(fakeChannel(true)).publish(otp)).resolves.toBeUndefined();
  });

  it('déclare l’exchange une fois par canal, et de nouveau sur un nouveau canal (reconnexion)', async () => {
    const first = fakeChannel();
    const second = fakeChannel();
    const publisher = publisherOn(first, first, second);
    await publisher.publish(succeeded());
    await publisher.publish(succeeded());
    await publisher.publish(succeeded());
    expect(first.assertExchange).toHaveBeenCalledTimes(1);
    expect(second.assertExchange).toHaveBeenCalledTimes(1);
  });
});
