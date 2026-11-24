import { type AppError } from '@ksp/platform';
import { asServiceFor, makeDeps, ORGANIZATION_ID, USER_ID } from './testing/fakes';
import { createUseCases } from './use-cases';

const USER = { type: 'user', id: USER_ID };
const CLAIM_ID = '0192f1c4-0000-7000-8000-00000000e101';
const SESSION_ID = '0192f1c4-0000-7000-8000-00000000e102';
const xof = (amount: number) => ({ amount, currency: 'XOF' });

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('crédit décidé par un service (WalletService.Credit, R-WL-04)', () => {
  let setup: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;

  beforeEach(() => {
    setup = makeDeps();
    useCases = createUseCases(setup.deps);
  });

  const credit = (overrides: Record<string, unknown> = {}, caller = 'cleaning') =>
    asServiceFor(caller, USER_ID, () =>
      useCases.creditByService.execute({
        idempotencyKey: `cleaning_claim:${CLAIM_ID}`,
        holder: USER,
        amount: xof(3000),
        object: { objectType: 'cleaning_claim', objectId: CLAIM_ID, part: '' },
        kind: 'commercial_gesture',
        description: 'Nettoyage — geste commercial, séance 3/15',
        relatedTransactionId: '',
        ...overrides,
      } as never),
    );

  it('crédite le portefeuille, contrepartie revenus des services ; événement v2 « geste commercial »', async () => {
    const result = await credit();
    expect(result).toMatchObject({
      created: true,
      wallet: { balance: 3000 },
      transaction: {
        kind: 'service_credit',
        caller: 'cleaning',
        object: { type: 'cleaning_claim', id: CLAIM_ID, part: null },
      },
    });
    expect(setup.store.balances.get('ksp:service_revenue')).toBe(-3000);
    expect(setup.store.events).toEqual([
      {
        type: 'wallet.prepaid.credited',
        version: 2,
        payload: expect.objectContaining({
          kind: 'commercial_gesture',
          origin: 'service',
          userId: USER_ID,
          amount: xof(3000),
          balanceAfter: xof(3000),
          paymentId: null,
          refundedTransactionId: null,
        }),
      },
    ]);
  });

  it('idempotent par (appelant, clé) : rejeu sans second crédit ; autre crédit avec la même clé refusé', async () => {
    await credit();
    expect(await credit()).toMatchObject({ created: false, wallet: { balance: 3000 } });
    expect(setup.store.events).toHaveLength(1);
    expect((await rejection(credit({ amount: xof(10) }))).code).toBe('WALLET_IDEMPOTENCY_KEY_REUSED');
    expect((await rejection(credit({ holder: { type: 'organization', id: ORGANIZATION_ID } }))).code).toBe(
      'WALLET_IDEMPOTENCY_KEY_REUSED',
    );
  });

  it('remboursement partiel d’un débit de l’appelant : débit d’origine repris dans l’événement', async () => {
    setup.topUps.record('0192f1c4-0000-7000-8000-00000000f101', USER_ID, 20000);
    await useCases.creditTopUp.execute({
      eventId: '0192f1c4-0000-7000-c000-000000000101',
      eventType: 'payment.intent.succeeded',
      paymentId: '0192f1c4-0000-7000-8000-00000000f101',
      subjectId: USER_ID,
      customerId: USER_ID,
      organizationId: null,
      amount: 20000,
    });
    const debit = await asServiceFor('cleaning', USER_ID, () =>
      useCases.debitPrepaid.execute({
        idempotencyKey: `cleaning_session:${SESSION_ID}`,
        holder: USER,
        amount: xof(15000),
        object: { objectType: 'cleaning_session', objectId: SESSION_ID, part: '' },
        description: 'Nettoyage — séance 3/15',
      }),
    );
    const refund = await credit({
      idempotencyKey: `cleaning_session:${SESSION_ID}:partial`,
      kind: 'refund',
      object: { objectType: 'cleaning_session', objectId: SESSION_ID, part: '' },
      relatedTransactionId: debit.transaction.id,
    });
    expect(refund.wallet.balance).toBe(5000 + 3000);
    expect(setup.store.events.at(-1)!.payload).toMatchObject({
      kind: 'refund',
      refundedTransactionId: debit.transaction.id,
    });
    // Débit inconnu, ou d'un autre titulaire : refusé.
    expect(
      (
        await rejection(
          credit({ idempotencyKey: 'cleaning_session:other-key', relatedTransactionId: CLAIM_ID }),
        )
      ).code,
    ).toBe('WALLET_TRANSACTION_NOT_FOUND');
  });

  it('contrôles : appelant autorisé, clé, sorte, montant, objet et libellé', async () => {
    expect((await rejection(credit({}, 'billing'))).code).toBe('WALLET_CALLER_FORBIDDEN');
    const field = async (overrides: Record<string, unknown>) =>
      ((await rejection(credit(overrides))).details as { field: string }).field;
    expect(await field({ idempotencyKey: 'court' })).toBe('idempotencyKey');
    expect(await field({ kind: 'top_up' })).toBe('kind');
    expect(await field({ amount: xof(0) })).toBe('amount');
    expect(await field({ object: { objectType: 'X', objectId: CLAIM_ID, part: '' } })).toBe(
      'object.objectType',
    );
    expect(await field({ description: '' })).toBe('description');
    expect(await field({ description: 'x'.repeat(141) })).toBe('description');
    expect(await field({ relatedTransactionId: 'pas-un-uuid' })).toBe('relatedTransactionId');
    expect(setup.store.transactions.size).toBe(0);
  });
});
