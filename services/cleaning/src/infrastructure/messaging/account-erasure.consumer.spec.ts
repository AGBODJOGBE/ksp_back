import { type RabbitMqConsumer } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type CleaningDeps } from '../../application/deps';
import { type AccountErasure } from '../../application/privacy/privacy.ports';
import { AccountErasureConsumer } from './account-erasure.consumer';

type Handler = (envelope: ReturnType<typeof deleted>) => Promise<void>;

const EVENT_ID = '0192f1c4-0000-7000-8000-0000000000e1';
const USER_ID = '0192F1C4-AAAA-7000-8000-000000000001';
const NOW = new Date('2026-11-23T10:00:00Z');

const deleted = (userId = USER_ID) => ({
  eventId: EVENT_ID,
  type: 'identity.user.deleted',
  payload: { userId },
});

const ERASED: AccountErasure = {
  status: 'processed',
  places: 2,
  requests: 3,
  visitArrivals: 1,
  sessionArrivals: 4,
  agentProfiles: 1,
};

/** Démarre l'écouteur sur un dépôt espion ; rend le gestionnaire de identity.user.deleted. */
async function start(outcome: AccountErasure | Error = ERASED) {
  const handlers = new Map<string, Handler>();
  const subscribe = jest.fn(
    async (type: string, handler: Handler, _options?: unknown) => void handlers.set(type, handler),
  );
  const eraseAccount = jest.fn(async (_userId: string, _event: unknown, _now: Date) => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const deps = { personalData: { eraseAccount }, clock: { now: () => NOW } } as unknown as CleaningDeps;
  await new AccountErasureConsumer(
    { subscribe } as unknown as RabbitMqConsumer,
    deps,
  ).onApplicationBootstrap();
  const handle = handlers.get('identity.user.deleted');
  if (!handle) throw new Error('aucun abonnement à identity.user.deleted');
  return { handle, subscribe, eraseAccount };
}

describe('AccountErasureConsumer : effacement à la suppression d’un compte (R-DP-02)', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('s’abonne au seul identity.user.deleted, en version 1', async () => {
    const { subscribe } = await start();
    expect(subscribe.mock.calls.map(([type]) => type)).toEqual(['identity.user.deleted']);
    expect(subscribe.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('efface les données du compte avec l’événement comme marque d’inbox', async () => {
    const { handle, eraseAccount } = await start();
    await handle(deleted());
    expect(eraseAccount.mock.calls).toEqual([
      [USER_ID.toLowerCase(), { eventId: EVENT_ID, consumer: 'cleaning.identity.user.deleted' }, NOW],
    ]);
  });

  it('journalise des nombres, jamais l’identifiant du compte', async () => {
    const { handle } = await start();
    await handle(deleted());
    expect(logged).toEqual([
      "Compte anonymisé : 2 lieu(x), 3 demande(s), 5 position(s) d'arrivée, 1 fiche(s) d'agent effacés",
    ]);
    expect(logged.join(' ').toLowerCase()).not.toContain(USER_ID.toLowerCase());
  });

  it('événement déjà traité : rien n’est journalisé', async () => {
    const { handle } = await start({ ...ERASED, status: 'duplicate' });
    await handle(deleted());
    expect(logged).toEqual([]);
  });

  it('un échec remonte : le message repart en file de reprise', async () => {
    const { handle } = await start(new Error('base injoignable'));
    await expect(handle(deleted())).rejects.toThrow('base injoignable');
  });
});
