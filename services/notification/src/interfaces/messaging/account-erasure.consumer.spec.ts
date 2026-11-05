import { type RabbitMqConsumer } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import {
  EraseUserNotificationsUseCase,
  type UserNotificationsErasure,
  type UserNotificationsEraser,
} from '../../application/privacy/erase-user-notifications.use-case';
import { AccountErasureConsumer } from './account-erasure.consumer';

const USER_ID = '0192F1C4-0000-7000-8000-000000000001';
const OTHER_USER_ID = '0192f1c4-0000-7000-8000-000000000002';

type Handler = (envelope: { eventId: string; type: string; payload: { userId: string } }) => Promise<void>;

/** Base en mémoire : notifications de l'espace et historique des envois, par compte. */
class InMemoryEraser implements UserNotificationsEraser {
  readonly processed = new Set<string>();
  inApp = [{ userId: USER_ID.toLowerCase() }, { userId: USER_ID.toLowerCase() }, { userId: OTHER_USER_ID }];
  deliveries: { recipientUserId: string | null; targetMasked: string }[] = [
    { recipientUserId: USER_ID.toLowerCase(), targetMasked: '+229********45' },
    { recipientUserId: OTHER_USER_ID, targetMasked: 'k***@exemple.com' },
  ];
  readonly calls: { userId: string; consumer: string }[] = [];
  failure: Error | null = null;

  async eraseUser(
    userId: string,
    inbox: { eventId: string; consumer: string },
  ): Promise<UserNotificationsErasure> {
    this.calls.push({ userId, consumer: inbox.consumer });
    if (this.failure) throw this.failure;
    const key = `${inbox.eventId}:${inbox.consumer}`;
    if (this.processed.has(key)) return { status: 'duplicate', inApp: 0, deliveries: 0 };
    this.processed.add(key);
    const before = this.inApp.length;
    this.inApp = this.inApp.filter((row) => row.userId !== userId);
    let deliveries = 0;
    this.deliveries = this.deliveries.map((row) => {
      if (row.recipientUserId !== userId) return row;
      deliveries += 1;
      return { recipientUserId: null, targetMasked: '' };
    });
    return { status: 'processed', inApp: before - this.inApp.length, deliveries };
  }
}

async function start(eraser: InMemoryEraser): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>();
  const consumer = {
    subscribe: jest.fn(async (type: string, handler: Handler) => void handlers.set(type, handler)),
  } as unknown as RabbitMqConsumer;
  await new AccountErasureConsumer(
    consumer,
    new EraseUserNotificationsUseCase(eraser),
  ).onApplicationBootstrap();
  return handlers;
}

const deleted = (eventId: string, userId = USER_ID) => ({
  eventId,
  type: 'identity.user.deleted',
  payload: { userId },
});

describe('AccountErasureConsumer (ADR-036)', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((...args: unknown[]) => void logs.push(String(args[0])));
  });
  afterEach(() => jest.restoreAllMocks());

  it('s’abonne au seul identity.user.deleted (file notification.identity.user.deleted)', async () => {
    const handlers = await start(new InMemoryEraser());
    expect([...handlers.keys()]).toEqual(['identity.user.deleted']);
  });

  it('efface les notifications de l’espace du compte et détache ses envois, sans toucher aux autres', async () => {
    const eraser = new InMemoryEraser();
    const handlers = await start(eraser);

    await handlers.get('identity.user.deleted')!(deleted('0192f1c4-aaaa-7000-8000-000000000001'));

    expect(eraser.calls).toEqual([
      { userId: USER_ID.toLowerCase(), consumer: 'notification.identity.user.deleted' },
    ]);
    expect(eraser.inApp).toEqual([{ userId: OTHER_USER_ID }]);
    expect(eraser.deliveries).toEqual([
      { recipientUserId: null, targetMasked: '' },
      { recipientUserId: OTHER_USER_ID, targetMasked: 'k***@exemple.com' },
    ]);
    expect(logs).toEqual([
      "Compte anonymisé : 2 notification(s) de l'espace effacée(s), 1 envoi(s) détaché(s)",
    ]);
    expect(logs.join(' ')).not.toContain(USER_ID.toLowerCase());
  });

  it('idempotent : le même événement livré deux fois n’a qu’un effet et n’est journalisé qu’une fois', async () => {
    const eraser = new InMemoryEraser();
    const handlers = await start(eraser);
    const handler = handlers.get('identity.user.deleted')!;

    await handler(deleted('0192f1c4-aaaa-7000-8000-000000000002'));
    // Une notification arrivée entre-temps n'est pas effacée par une seconde livraison.
    eraser.inApp.push({ userId: USER_ID.toLowerCase() });
    await handler(deleted('0192f1c4-aaaa-7000-8000-000000000002'));

    expect(eraser.calls).toHaveLength(2);
    expect(eraser.inApp).toHaveLength(2);
    expect(logs).toHaveLength(1);
  });

  it('compte sans notification : événement traité, rien à effacer', async () => {
    const eraser = new InMemoryEraser();
    const handlers = await start(eraser);

    await handlers.get('identity.user.deleted')!(
      deleted('0192f1c4-aaaa-7000-8000-000000000003', '0192f1c4-0000-7000-8000-000000000009'),
    );

    expect(eraser.processed.size).toBe(1);
    expect(eraser.inApp).toHaveLength(3);
    expect(eraser.deliveries.filter((row) => row.recipientUserId === null)).toHaveLength(0);
    expect(logs).toEqual([
      "Compte anonymisé : 0 notification(s) de l'espace effacée(s), 0 envoi(s) détaché(s)",
    ]);
  });

  it('échec de la base : l’erreur remonte pour que le message soit repris', async () => {
    const eraser = new InMemoryEraser();
    eraser.failure = new Error('base indisponible');
    const handlers = await start(eraser);

    await expect(
      handlers.get('identity.user.deleted')!(deleted('0192f1c4-aaaa-7000-8000-000000000004')),
    ).rejects.toThrow('base indisponible');
    expect(logs).toEqual([]);
  });
});
