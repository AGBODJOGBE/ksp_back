import { asServiceFor, type FakeDebitChecks, type FixedClock, makeDeps, USER_ID } from './testing/fakes';
import { createUseCases } from './use-cases';

/**
 * Rapprochement des débits du portefeuille (ADR-048) : un débit fait pour un service dont le paiement
 * n'a pas été enregistré (panne entre le débit et l'enregistrement) est remboursé ; un débit
 * enregistré est noté vérifié et n'est plus relu ; un débit encore en cours chez l'appelant (RV-80)
 * est redemandé au passage suivant, jamais remboursé.
 */
const SESSION_ID = '0192f1c4-0000-7000-8000-00000000e001';
const INVOICE_ID = '0192f1c4-0000-7000-8000-00000000e002';
const MINUTE = 60_000;

describe('rapprochement des débits du portefeuille (ADR-048)', () => {
  let setup: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const checks = () => setup.deps.debitChecks as FakeDebitChecks;
  const clock = () => setup.deps.clock as FixedClock;

  beforeEach(async () => {
    setup = makeDeps();
    useCases = createUseCases(setup.deps);
    setup.topUps.record('0192f1c4-0000-7000-8000-00000000f001', USER_ID, 50000);
    await useCases.creditTopUp.execute({
      eventId: '0192f1c4-0000-7000-c000-000000000001',
      eventType: 'payment.intent.succeeded',
      paymentId: '0192f1c4-0000-7000-8000-00000000f001',
      subjectId: USER_ID,
      customerId: USER_ID,
      organizationId: null,
      amount: 50000,
    });
  });

  const debit = (caller: string, objectType: string, objectId: string, key: string) =>
    asServiceFor(caller, USER_ID, () =>
      useCases.debitPrepaid.execute({
        idempotencyKey: key,
        holder: { type: 'user', id: USER_ID },
        amount: { amount: 15000, currency: 'XOF' },
        object: { objectType, objectId, part: '' },
        description: 'Paiement',
      }),
    );
  const balance = async () => (await setup.store.prepaidSummary({ type: 'user', id: USER_ID })).balance;

  it('débit récent : pas encore relu ; ancien et non enregistré : remboursé une fois ; enregistré : vérifié', async () => {
    const lost = await debit('cleaning', 'cleaning_session', SESSION_ID, 'debit-key-0001');
    const kept = await debit('billing', 'billing_invoice', INVOICE_ID, 'debit-key-0002');
    checks().recorded.add(kept.transaction.id);
    expect(await useCases.reconcileDebits.execute()).toMatchObject({ examined: 0 });

    clock().advance(31 * MINUTE);
    expect(await useCases.reconcileDebits.execute()).toEqual({
      examined: 2,
      recorded: 1,
      refunded: 1,
      inProgress: 0,
      errors: 0,
    });
    expect(checks().asked).toEqual(
      expect.arrayContaining([
        {
          caller: 'cleaning',
          objectType: 'cleaning_session',
          objectId: SESSION_ID,
          transactionId: lost.transaction.id,
        },
        {
          caller: 'billing',
          objectType: 'billing_invoice',
          objectId: INVOICE_ID,
          transactionId: kept.transaction.id,
        },
      ]),
    );
    expect(await setup.store.findReversalOf(lost.transaction.id)).toMatchObject({ kind: 'refund' });
    expect(await setup.store.findReversalOf(kept.transaction.id)).toBeNull();
    expect(await balance()).toBe(35000);
    // Plus rien à relire : ni le débit vérifié, ni le débit remboursé.
    clock().advance(31 * MINUTE);
    expect(await useCases.reconcileDebits.execute()).toMatchObject({ examined: 0 });
  });

  it('opération encore en cours chez cleaning (RV-80) : redemandée au passage suivant, jamais remboursée', async () => {
    const pending = await debit('cleaning', 'cleaning_session', SESSION_ID, 'debit-key-0004');
    checks().inProgress.add(pending.transaction.id);
    clock().advance(31 * MINUTE);
    expect(await useCases.reconcileDebits.execute()).toEqual({
      examined: 1,
      recorded: 0,
      refunded: 0,
      inProgress: 1,
      errors: 0,
    });
    expect(await setup.store.findReversalOf(pending.transaction.id)).toBeNull();
    // Des heures plus tard, toujours en cours : toujours redemandée, toujours pas remboursée.
    clock().advance(6 * 60 * MINUTE);
    expect(await useCases.reconcileDebits.execute()).toMatchObject({ examined: 1, inProgress: 1 });
    expect(await balance()).toBe(35000);
    // L'opération aboutit chez cleaning : le débit est noté vérifié et n'est plus relu.
    checks().inProgress.delete(pending.transaction.id);
    checks().recorded.add(pending.transaction.id);
    expect(await useCases.reconcileDebits.execute()).toMatchObject({ examined: 1, recorded: 1 });
    expect(await useCases.reconcileDebits.execute()).toMatchObject({ examined: 0 });
  });

  it('service injoignable : débit laissé pour le prochain passage, jamais remboursé à l’aveugle', async () => {
    await debit('cleaning', 'cleaning_session', SESSION_ID, 'debit-key-0003');
    checks().down = true;
    clock().advance(31 * MINUTE);
    expect(await useCases.reconcileDebits.execute()).toMatchObject({ examined: 1, errors: 1, refunded: 0 });
    expect(await balance()).toBe(35000);
    checks().down = false;
    checks().recordedAll = true;
    expect(await useCases.reconcileDebits.execute()).toMatchObject({ examined: 1, recorded: 1 });
  });
});
