import { type AppError, runWithContext } from '@ksp/platform';
import { makeDeps, STAFF_ID, USER_ID } from './testing/fakes';
import { createUseCases, type WalletUseCases } from './use-cases';

/**
 * Méthodes « utilisateur » et back-office : seule la gateway les appelle (ADR-048). Un autre service
 * qui transmettrait un utilisateur dans ses métadonnées est refusé, avant toute lecture ou écriture.
 */
const USER = { type: 'user', id: USER_ID };
const PAGE = { limit: 20, cursor: null };
const CALLS: [string, (u: WalletUseCases) => Promise<unknown>][] = [
  ['getMyWallet', (u) => u.getMyWallet.execute()],
  ['listMyStatement', (u) => u.listMyStatement.execute({ page: PAGE, account: '' })],
  ['listMyPayouts', (u) => u.listMyPayouts.execute({ page: PAGE, status: '' })],
  [
    'createTopUp',
    (u) =>
      u.createTopUp.execute({ idempotencyKey: 'topup-key-0001', amount: { amount: 5000, currency: 'XOF' } }),
  ],
  ['getHolderWallet', (u) => u.getHolderWallet.execute(USER)],
  ['listHolderStatement', (u) => u.listHolderStatement.execute({ holder: USER, page: PAGE, account: '' })],
  ['listWalletPayouts', (u) => u.listWalletPayouts.execute({ page: PAGE, status: '', holder: undefined })],
  ['getLedgerOverview', (u) => u.getLedgerOverview.execute()],
  [
    'creditPrepaidWallet',
    (u) =>
      u.creditPrepaidWallet.execute({
        idempotencyKey: 'credit-key-0001',
        holder: USER,
        kind: 'refund',
        amount: { amount: 1000, currency: 'XOF' },
        reason: 'Geste commercial après un passage manqué',
        paymentId: '',
      }),
  ],
];

describe('méthodes réservées à la gateway (wallet)', () => {
  const useCases = createUseCases(makeDeps().deps);

  it.each(CALLS)('%s : un autre service est refusé', async (_name, call) => {
    let error: AppError | undefined;
    try {
      await runWithContext(
        {
          correlationId: 'c-test',
          callerService: 'cleaning',
          user: {
            userId: STAFF_ID,
            sessionId: 's-test',
            activeContext: 'personal',
            roles: [
              { role: 'finance_officer', scopeType: 'global' },
              { role: 'customer', scopeType: 'global' },
            ],
            mfa: true,
            authTime: Math.floor(Date.now() / 1000),
          },
        },
        () => call(useCases),
      );
    } catch (caught) {
      error = caught as AppError;
    }
    expect(error?.code).toBe('WALLET_CALLER_FORBIDDEN');
  });
});
