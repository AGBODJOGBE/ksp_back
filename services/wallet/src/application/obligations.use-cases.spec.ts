import { type AppError } from '@ksp/platform';
import { asService, makeDeps, USER_ID } from './testing/fakes';
import { createUseCases } from './use-cases';

/**
 * ksp.common.v1.ObligationService (UC-ID-11, ADR-036, ADR-048) : de l'argent encore sur le
 * portefeuille du compte, ou un reversement en cours, bloque sa suppression.
 */
describe('obligations avant la suppression d’un compte (wallet)', () => {
  let setup: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const USER = { type: 'user', id: USER_ID };
  const xof = (amount: number) => ({ amount, currency: 'XOF' });

  beforeEach(() => {
    setup = makeDeps();
    useCases = createUseCases(setup.deps);
  });

  const ask = (service = 'identity') =>
    asService(service, () => useCases.hasPendingObligations.execute({ userId: USER_ID }));

  it('portefeuille vide, aucun reversement : rien', async () => {
    expect(await ask()).toEqual([]);
  });

  it('solde prépayé, fonds dus puis reversement en cours : bloquent', async () => {
    setup.topUps.record('0192f1c4-0000-7000-8000-00000000f001', USER_ID, 2500);
    await useCases.creditTopUp.execute({
      eventId: '0192f1c4-0000-7000-c000-000000000001',
      eventType: 'payment.intent.succeeded',
      paymentId: '0192f1c4-0000-7000-8000-00000000f001',
      subjectId: USER_ID,
      customerId: USER_ID,
      organizationId: null,
      amount: 2500,
    });
    expect(await ask()).toEqual([
      expect.objectContaining({ kind: 'prepaid_balance', description: expect.stringContaining('2 500') }),
    ]);
    await asService('recovery', () =>
      useCases.recordCollection.execute({
        holder: USER,
        grossAmount: xof(10000),
        commissionRateBps: 0,
        reference: 'payment:0192f1c4-0000-7000-8000-00000000f002',
        description: 'Échéance',
      }),
    );
    expect((await ask()).map((o) => o.kind)).toEqual(['prepaid_balance', 'funds_owed']);
    await asService('recovery', () =>
      useCases.requestPayout.execute({
        idempotencyKey: 'payout-key-0001',
        holder: USER,
        amount: xof(10000),
        beneficiary: { phone: '+2290197000045', operator: 'mtn', name: 'Koffi' },
      }),
    );
    expect((await ask()).map((o) => o.kind)).toEqual(['prepaid_balance', 'payout_in_progress']);
  });

  it('seul identity peut interroger ; identifiant vérifié', async () => {
    const forbidden = (await ask('cleaning').catch((e: unknown) => e)) as AppError;
    expect(forbidden.code).toBe('WALLET_CALLER_FORBIDDEN');
    const invalid = (await asService('identity', () =>
      useCases.hasPendingObligations.execute({ userId: 'x' }),
    ).catch((e: unknown) => e)) as AppError;
    expect(invalid.code).toBe('WALLET_VALIDATION_FAILED');
  });
});
