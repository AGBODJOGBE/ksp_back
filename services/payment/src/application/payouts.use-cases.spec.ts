import { type AppError } from '@ksp/platform';
import {
  asService,
  asStaff,
  FakePayoutProvider,
  type FixedClock,
  type InMemoryPayouts,
  makeDeps,
  type RecordingAlerts,
  STAFF_ID,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const KEY = 'wallet-payout-0001';

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

const request = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: KEY,
  reference: '0192f1c4-0000-7000-8000-0000000aa001',
  amount: { amount: 22500, currency: 'XOF' },
  beneficiary: { phone: '+2290197000045', operator: 'mtn', name: 'SARL Bénin Immo' },
  ...overrides,
});

describe('reversements (cas d’usage, ADR-041)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const payouts = () => deps.payouts as InMemoryPayouts;
  const clock = () => deps.clock as FixedClock;

  const requestPayout = (overrides: Record<string, unknown> = {}, caller = 'wallet') =>
    asService(caller, () => useCases.requestPayout.execute(request(overrides) as never));

  describe('mode manuel (par défaut)', () => {
    beforeEach(() => {
      deps = makeDeps();
      useCases = createUseCases(deps);
    });

    it('enregistré « requested », idempotent ; aucune issue publiée', async () => {
      const { payout, created } = await requestPayout();
      expect(created).toBe(true);
      expect(payout).toMatchObject({
        status: 'requested',
        provider: 'manual',
        issuer: 'wallet',
        amount: 22500,
      });
      expect((await requestPayout()).payout.id).toBe(payout.id);
      const reused = await rejection(requestPayout({ amount: { amount: 1, currency: 'XOF' } }));
      expect(reused.code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
      expect(payouts().outbox).toEqual([]);
    });

    it('réservé aux émetteurs autorisés ; bénéficiaire béninois et opérateur connu', async () => {
      expect((await rejection(requestPayout({}, 'recovery'))).code).toBe('PAYMENT_CALLER_FORBIDDEN');
      const phone = await rejection(
        requestPayout({ beneficiary: { phone: '+33612345678', operator: 'mtn', name: 'X' } }),
      );
      expect(phone.details).toEqual({ field: 'beneficiary.phone' });
      const operator = await rejection(
        requestPayout({ beneficiary: { phone: '+22997000045', operator: 'orange', name: 'X' } }),
      );
      expect(operator.details).toEqual({ field: 'beneficiary.operator' });
    });

    it('la finance confirme le virement : payment.payout.completed, sans numéro ni nom', async () => {
      const { payout } = await requestPayout();
      const confirm = () =>
        asStaff(() =>
          useCases.confirmPayout.execute({ payoutId: payout.id, text: 'MTN-TRF-0042', idempotencyKey: '' }),
        );
      const done = await confirm();
      expect(done).toMatchObject({
        status: 'completed',
        providerReference: 'MTN-TRF-0042',
        settledBy: STAFF_ID,
      });
      expect(payouts().outbox).toEqual([
        {
          type: 'payment.payout.completed',
          payload: {
            payoutId: payout.id,
            issuer: 'wallet',
            reference: request().reference,
            amount: { amount: 22500, currency: 'XOF' },
            provider: 'manual',
            providerReference: 'MTN-TRF-0042',
            completedAt: clock().now().toISOString(),
          },
        },
      ]);
      // Rejeu sans effet ; autre issue refusée.
      expect((await confirm()).status).toBe('completed');
      const other = await rejection(
        asStaff(() =>
          useCases.failPayout.execute({ payoutId: payout.id, text: 'Numéro faux', idempotencyKey: '' }),
        ),
      );
      expect(other.code).toBe('PAYMENT_PAYOUT_ALREADY_SETTLED');
      expect(payouts().outbox).toHaveLength(1);
    });

    it('la finance déclare l’échec : payment.payout.failed (code seulement, jamais la raison)', async () => {
      const { payout } = await requestPayout();
      await asStaff(() =>
        useCases.failPayout.execute({
          payoutId: payout.id,
          text: 'Numéro inconnu chez MTN',
          idempotencyKey: 'k-0000001',
        }),
      );
      expect(payouts().outbox[0]).toMatchObject({
        type: 'payment.payout.failed',
        payload: { failureCode: 'rejected_by_finance' },
      });
      expect(JSON.stringify(payouts().outbox)).not.toContain('Numéro inconnu');
    });

    it('réservé à la finance avec double authentification', async () => {
      const { payout } = await requestPayout();
      const confirm = (role: string, mfa: boolean) =>
        asStaff(
          () => useCases.confirmPayout.execute({ payoutId: payout.id, text: 'REF', idempotencyKey: '' }),
          role,
          mfa,
        );
      expect((await rejection(confirm('cleaning_admin', true))).code).toBe('AUTH_FORBIDDEN');
      expect((await rejection(confirm('finance_officer', false))).code).toBe('AUTH_MFA_REQUIRED');
      const list = await asStaff(() =>
        useCases.listPayouts.execute({ page: { limit: 20, cursor: null }, status: 'requested', issuer: '' }),
      );
      expect(list.items.map((p) => p.id)).toEqual([payout.id]);
    });
  });

  describe('prestataire automatique', () => {
    let provider: FakePayoutProvider;

    beforeEach(() => {
      provider = new FakePayoutProvider();
      deps = makeDeps({ payoutProvider: provider });
      useCases = createUseCases(deps);
    });

    it('créé puis lancé aussitôt ; envoyé : payment.payout.completed ; confirmation manuelle refusée', async () => {
      const { payout } = await requestPayout();
      expect(payout).toMatchObject({ status: 'processing', provider: 'fedapay', providerPayoutId: '9001' });
      expect(provider.created[0]!.beneficiary.phone).toBe('+2290197000045');
      provider.set('9001', { status: 'sent' });
      clock().advance(60_000);
      expect(await useCases.reconcilePayouts.execute()).toMatchObject({ examined: 1, completed: 1 });
      expect(payouts().outbox.map((e) => e.type)).toEqual(['payment.payout.completed']);
      const manual = await rejection(
        asStaff(() => useCases.confirmPayout.execute({ payoutId: payout.id, text: 'X', idempotencyKey: '' })),
      );
      expect(manual.code).toBe('PAYMENT_PAYOUT_NOT_MANUAL');
    });

    it('prestataire en panne : reste « requested », lancé au rapprochement', async () => {
      provider.down = true;
      const { payout } = await requestPayout();
      expect(payout.status).toBe('requested');
      provider.down = false;
      await useCases.reconcilePayouts.execute();
      expect(payouts().rows.get(payout.id)!.status).toBe('processing');
      expect(provider.started).toEqual(['9001']);
    });

    it('réponse du lancement perdue : relu avant tout nouveau lancement (jamais deux envois)', async () => {
      provider.loseStartResponse = true;
      const { payout } = await requestPayout();
      expect(payout.status).toBe('requested');
      provider.loseStartResponse = false;
      await useCases.reconcilePayouts.execute();
      expect(provider.started).toEqual(['9001']);
      expect(provider.created).toHaveLength(1);
      expect(payouts().rows.get(payout.id)!.status).toBe('processing');
    });

    it('refusé par le prestataire : payment.payout.failed ; notification payout.* traitée', async () => {
      const { payout } = await requestPayout();
      provider.set('9001', { status: 'failed' });
      const outcome = await asService('gateway', () =>
        useCases.receiveProviderNotification.execute({
          provider: 'fedapay',
          payload: Buffer.from(JSON.stringify({ name: 'payout.failed', entity: { id: 9001 } })),
          signature: 'valid',
        }),
      );
      expect(outcome).toBe('applied');
      expect(payouts().rows.get(payout.id)!).toMatchObject({
        status: 'failed',
        failureCode: 'provider_failed',
      });
      expect(payouts().outbox[0]).toMatchObject({ type: 'payment.payout.failed' });
    });

    it('montant relu différent : statut ignoré, alerte', async () => {
      const { payout } = await requestPayout();
      provider.set('9001', { status: 'sent', amount: 100 });
      clock().advance(60_000);
      await useCases.reconcilePayouts.execute();
      expect(payouts().rows.get(payout.id)!.status).toBe('processing');
      expect((deps.alerts as RecordingAlerts).payoutMismatches).toHaveLength(1);
      expect(payouts().outbox).toEqual([]);
    });
  });
});
