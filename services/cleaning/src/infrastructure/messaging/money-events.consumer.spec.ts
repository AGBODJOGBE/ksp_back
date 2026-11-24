import { type RabbitMqConsumer } from '@ksp/platform';
import { type LotCUseCases } from '../../application/requests/lot-c-use-cases';
import { MoneyEventsConsumer } from './money-events.consumer';
import { type WalletEventsConsumer } from './wallet-events.consumer';

type Target = { service: string; objectType: string; objectId: string };
type Handler = (envelope: ReturnType<typeof credited>) => Promise<void>;

const EVENT_ID = '0192f1c4-0000-7000-8000-0000000000e1';
const PAYMENT_ID = '0192f1c4-0000-7000-8000-0000000000b1';
const HOLDER = { type: 'user', id: '0192f1c4-0000-7000-8000-000000000001' };
const SESSION: Target = {
  service: 'cleaning',
  objectType: 'cleaning_session',
  objectId: '0192f1c4-0000-7000-8000-0000000000c1',
};
const REQUEST: Target = {
  service: 'cleaning',
  objectType: 'cleaning_request',
  objectId: '0192f1c4-0000-7000-8000-0000000000d1',
};

/** Crédit du wallet ; sans objet visé, le message a la forme de la version 1. */
const credited = (forObject?: Target) => ({
  eventId: EVENT_ID,
  type: 'wallet.prepaid.credited',
  payload: {
    holder: HOLDER,
    transactionId: '0192f1c4-0000-7000-8000-0000000000a1',
    paymentId: PAYMENT_ID,
    amount: { amount: 5000, currency: 'XOF' },
    ...(forObject ? { forObject } : {}),
  },
});

/** Démarre le consommateur avec deux traitements espions ; `calls` garde l'ordre de leurs appels. */
async function start(options: { sessionsFail?: boolean } = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  const subscribe = jest.fn(
    async (type: string, handler: Handler, _options?: unknown) => void handlers.set(type, handler),
  );
  const onPrepaidCredited = jest.fn(async (_event: unknown) => {
    calls.push('frais de visite');
    return { status: 'processed', debitedRequestIds: [], leftInWallet: [] };
  });
  const useCases = {
    money: { onPrepaidCredited, onPaymentSucceeded: jest.fn(async () => undefined) },
  } as unknown as LotCUseCases;
  const sessions = {
    onPrepaidCredited: jest.fn(async () => {
      calls.push('séances');
      if (options.sessionsFail) throw new Error('wallet indisponible');
    }),
  } as unknown as WalletEventsConsumer;
  await new MoneyEventsConsumer(
    { subscribe } as unknown as RabbitMqConsumer,
    useCases,
    sessions,
  ).onApplicationBootstrap();
  const handle = handlers.get('wallet.prepaid.credited');
  if (!handle) throw new Error('aucun abonnement à wallet.prepaid.credited');
  return { calls, handle, subscribe, onPrepaidCredited };
}

describe('MoneyEventsConsumer : une seule écoute du crédit du wallet pour les frais de visite et les séances', () => {
  it('s’abonne une seule fois à chaque type, le crédit du wallet en versions 1 et 2', async () => {
    const { subscribe } = await start();
    expect(subscribe.mock.calls.map(([type]) => type)).toEqual([
      'wallet.prepaid.credited',
      'payment.intent.succeeded',
    ]);
    expect(subscribe.mock.calls[0]?.[2]).toEqual({ versions: [1, 2] });
  });

  it('un crédit qui vise une séance sert la séance avant de relancer les frais de visite', async () => {
    const { calls, handle } = await start();
    await handle(credited(SESSION));
    expect(calls).toEqual(['séances', 'frais de visite']);
  });

  it('un crédit qui vise une demande sert les frais de visite avant de relancer les séances', async () => {
    const { calls, handle } = await start();
    await handle(credited(REQUEST));
    expect(calls).toEqual(['frais de visite', 'séances']);
  });

  it('une recharge sans objet visé relance les frais de visite puis les séances', async () => {
    const { calls, handle } = await start();
    await handle(credited());
    expect(calls).toEqual(['frais de visite', 'séances']);
  });

  it('transmet aux frais de visite l’objet visé, ou null pour un message en version 1', async () => {
    const { handle, onPrepaidCredited } = await start();
    await handle(credited(REQUEST));
    await handle(credited());
    expect(onPrepaidCredited.mock.calls.map(([event]) => event)).toEqual([
      { eventId: EVENT_ID, holder: HOLDER, forObject: REQUEST, paymentId: PAYMENT_ID },
      { eventId: EVENT_ID, holder: HOLDER, forObject: null, paymentId: PAYMENT_ID },
    ]);
  });

  it('un échec du traitement des séances remonte : le message repart en file de reprise', async () => {
    const { calls, handle } = await start({ sessionsFail: true });
    await expect(handle(credited())).rejects.toThrow('wallet indisponible');
    expect(calls).toEqual(['frais de visite', 'séances']);
  });
});
