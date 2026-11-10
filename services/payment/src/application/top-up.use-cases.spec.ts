import { type AppError, runWithContext } from '@ksp/platform';
import {
  asService,
  CUSTOMER_ID,
  type FakeProvider,
  type InMemoryPayments,
  makeDeps,
  ORGANIZATION_ID,
} from './testing/fakes';
import { createUseCases } from './use-cases';

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

/** Appel de wallet pour un client connecté (métadonnées transmises par le kit). */
function fromWallet<T>(fn: () => Promise<T>, organizationId?: string, service = 'wallet'): Promise<T> {
  return runWithContext(
    {
      correlationId: 'c-test',
      callerService: service,
      user: {
        userId: CUSTOMER_ID,
        sessionId: 's-test',
        activeContext: organizationId ?? 'personal',
        roles: [],
        mfa: false,
      },
    },
    fn,
  );
}

describe('recharge du portefeuille prépayé (ADR-046)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const payments = () => deps.payments as InMemoryPayments;
  const provider = () => deps.provider as FakeProvider;

  beforeEach(() => {
    deps = makeDeps();
    useCases = createUseCases(deps);
  });

  const topUp = (amount = 5000, key = 'topup-key-0001', organizationId?: string) =>
    fromWallet(
      () => useCases.createTopUpPayment.execute({ idempotencyKey: key, amount: { amount, currency: 'XOF' } }),
      organizationId,
    );

  it('paiement de l’objet wallet_top_up pour le titulaire, page de paiement, rejeu sans doublon', async () => {
    const first = await topUp();
    expect(first.created).toBe(true);
    expect(first.payment).toMatchObject({
      subject: { type: 'wallet_top_up', id: CUSTOMER_ID, part: null, reference: null },
      amount: 5000,
      customerId: CUSTOMER_ID,
      organizationId: null,
      status: 'pending',
      checkoutUrl: expect.stringContaining('https://'),
    });
    expect(provider().checkouts.at(-1)?.description).toBe('KSP - Recharge du portefeuille');
    const again = await topUp();
    expect(again).toMatchObject({ created: false, payment: { id: first.payment.id } });
    expect((await rejection(topUp(6000))).code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
  });

  it('organisation active : titulaire = organisation ; page ouverte remplacée pour un autre montant', async () => {
    const first = await topUp(5000, 'topup-key-0002', ORGANIZATION_ID);
    expect(first.payment.subject.id).toBe(ORGANIZATION_ID);
    expect(first.payment.organizationId).toBe(ORGANIZATION_ID);
    const same = await topUp(5000, 'topup-key-0003', ORGANIZATION_ID);
    expect(same).toMatchObject({ created: false, payment: { id: first.payment.id } });
    const other = await topUp(8000, 'topup-key-0004', ORGANIZATION_ID);
    expect(other.created).toBe(true);
    expect((await payments().findById(first.payment.id))?.status).toBe('cancelled');
  });

  it('réussite confirmée : payment.intent.succeeded de l’objet wallet_top_up', async () => {
    const { payment } = await topUp();
    provider().set(payment.providerTransactionId!, { status: 'approved' });
    await asService('gateway', () =>
      useCases.receiveProviderNotification.execute({
        provider: 'fedapay',
        payload: Buffer.from(
          JSON.stringify({
            name: 'transaction.approved',
            entity: { id: Number(payment.providerTransactionId) },
          }),
        ),
        signature: 'valid',
      }),
    );
    expect(payments().outbox.at(-1)).toMatchObject({
      type: 'payment.intent.succeeded',
      payload: { subjectType: 'wallet_top_up', subjectId: CUSTOMER_ID, part: null, amount: { amount: 5000 } },
    });
  });

  it('réservé à wallet ; jamais par la création d’un paiement client ni par un lien', async () => {
    const run = () =>
      fromWallet(
        () =>
          useCases.createTopUpPayment.execute({
            idempotencyKey: 'topup-key-0005',
            amount: { amount: 5000, currency: 'XOF' },
          }),
        undefined,
        'cleaning',
      );
    expect((await rejection(run())).code).toBe('PAYMENT_CALLER_FORBIDDEN');
    const direct = (from: typeof fromWallet) =>
      rejection(
        from(() =>
          useCases.createPayment.execute({
            subjectType: 'wallet_top_up',
            subjectId: CUSTOMER_ID,
            part: '',
            idempotencyKey: 'topup-key-0006',
          }),
        ),
      );
    // wallet n'appelle jamais une méthode du client (réservée à la gateway, ADR-048).
    expect((await direct(fromWallet)).code).toBe('PAYMENT_CALLER_FORBIDDEN');
    // Par la gateway : objet réservé, refusé à la validation.
    const viaGateway: typeof fromWallet = (fn) => fromWallet(fn, undefined, 'gateway');
    expect((await direct(viaGateway)).code).toBe('PAYMENT_VALIDATION_FAILED');
  });
});
