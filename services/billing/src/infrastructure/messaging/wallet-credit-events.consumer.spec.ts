import { type WalletEventPayloads } from '@ksp/contracts';
import { type RabbitMqConsumer } from '@ksp/platform';
import { type MonthlyBillingUseCases } from '../../application/monthly/use-cases';
import { type RecoveryBillingUseCases } from '../../application/recovery/use-cases';
import { WalletCreditEventsConsumer } from './wallet-credit-events.consumer';

type Handler = (envelope: {
  eventId: string;
  payload: WalletEventPayloads['wallet.prepaid.credited'];
}) => Promise<void>;

const payload: WalletEventPayloads['wallet.prepaid.credited'] = {
  transactionId: '0192f1c4-0000-7000-8000-00000000c001',
  kind: 'top_up',
  origin: 'payment',
  holder: { type: 'organization', id: '0192f1c4-0000-7000-8000-00000000a001' },
  userId: null,
  amount: { amount: 20_000, currency: 'XOF' },
  balanceAfter: { amount: 20_000, currency: 'XOF' },
  description: 'Recharge Mobile Money',
  paymentId: null,
  refundedTransactionId: null,
  creditedAt: '2026-12-01T09:00:00Z',
};

describe('WalletCreditEventsConsumer (wallet.prepaid.credited)', () => {
  function setup(retry: () => Promise<unknown>) {
    const subscriptions: { type: string; handler: Handler; options: unknown }[] = [];
    const calls: string[] = [];
    const consumer = {
      subscribe: async (type: string, handler: Handler, options: unknown) => {
        subscriptions.push({ type, handler, options });
      },
    } as unknown as RabbitMqConsumer;
    const monthly = {
      settleInvoiceFromWalletCredit: {
        execute: async () => {
          calls.push('facture');
          return 'ignored';
        },
      },
    } as unknown as MonthlyBillingUseCases;
    const recovery = {
      retryCommissionDebitsOnWalletCredit: {
        execute: async (input: { payload: typeof payload }) => {
          calls.push(`commissions:${input.payload.holder.id}`);
          return retry();
        },
      },
    } as unknown as RecoveryBillingUseCases;
    return { subscriptions, calls, listener: new WalletCreditEventsConsumer(consumer, monthly, recovery) };
  }

  it('un seul abonnement, versions 1 et 2 : facture visée, puis commissions dues du titulaire', async () => {
    const { subscriptions, calls, listener } = setup(async () => ({ due: 1, paid: 1, failures: [] }));
    await listener.onApplicationBootstrap();
    expect(subscriptions.map((each) => [each.type, each.options])).toEqual([
      ['wallet.prepaid.credited', { versions: [1, 2] }],
    ]);
    await subscriptions[0]!.handler({ eventId: 'e1', payload });
    expect(calls).toEqual(['facture', `commissions:${payload.holder.id}`]);
  });

  it('verrou pris ou échec : l’erreur remonte, le message revient par la file de reprise', async () => {
    const { subscriptions, listener } = setup(() =>
      Promise.reject(
        new Error('Débit des commissions en cours ; nouvel essai après le crédit du portefeuille.'),
      ),
    );
    await listener.onApplicationBootstrap();
    await expect(subscriptions[0]!.handler({ eventId: 'e1', payload })).rejects.toThrow(/en cours/);
  });
});
