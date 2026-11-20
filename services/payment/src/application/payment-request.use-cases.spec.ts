import { type AppError, runWithContext } from '@ksp/platform';
import {
  asService,
  CUSTOMER_ID,
  type FakeProvider,
  type InMemoryPayments,
  makeDeps,
  ORGANIZATION_ID,
  OTHER_CUSTOMER_ID,
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

const SESSION_ID = '0192f1c4-0000-7000-8000-0000000e0001';
const OTHER_SESSION_ID = '0192f1c4-0000-7000-8000-0000000e0002';
const MINUTE = 60_000;

type Request = Parameters<ReturnType<typeof createUseCases>['createPaymentRequest']['execute']>[0];

/** Demande de cleaning pour une séance : montant exact, libellé, objet visé. */
function request(overrides: Partial<Request> = {}): Request {
  return {
    idempotencyKey: `cleaning_session:${SESSION_ID}:1`,
    customerId: CUSTOMER_ID,
    organizationId: '',
    amount: { amount: 12000, currency: 'XOF' },
    target: {
      service: '',
      objectType: 'cleaning_session',
      objectId: SESSION_ID,
      part: '',
      reference: 'séance 3/15',
    },
    description: 'Nettoyage — séance 3/15',
    expiresAt: '',
    ...overrides,
  };
}

describe('paiement direct d’un objet (CreatePaymentRequest, v2)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const payments = () => deps.payments as InMemoryPayments;
  const provider = () => deps.provider as FakeProvider;

  beforeEach(() => {
    deps = makeDeps();
    useCases = createUseCases(deps);
  });

  const ask = (overrides: Partial<Request> = {}, service = 'cleaning') =>
    asService(service, () => useCases.createPaymentRequest.execute(request(overrides)));

  it('recharge wallet_top_up du compte qui porte l’objet visé, service tiré du jeton, page de paiement', async () => {
    // Le service indiqué dans la requête est ignoré : seul le jeton de service fait foi.
    const result = await ask({ target: { ...request().target!, service: 'billing' } });
    expect(result.created).toBe(true);
    expect(result.payment).toMatchObject({
      subject: { type: 'wallet_top_up', id: CUSTOMER_ID, part: null, reference: null },
      amount: 12000,
      customerId: CUSTOMER_ID,
      organizationId: null,
      paymentLinkId: null,
      status: 'pending',
      checkoutUrl: expect.stringContaining('https://'),
      target: {
        service: 'cleaning',
        objectType: 'cleaning_session',
        objectId: SESSION_ID,
        part: null,
        reference: 'séance 3/15',
      },
      description: 'Nettoyage — séance 3/15',
    });
    // Durée par défaut de payment : celle d'une recharge (prestataire qui sait annuler sa page).
    expect(result.payment.expiresAt).toEqual(new Date(deps.clock.now().getTime() + 30 * MINUTE));
    expect(provider().checkouts.at(-1)).toMatchObject({
      amount: 12000,
      description: 'KSP - Nettoyage — séance 3/15',
    });
  });

  it('organisation renseignée : titulaire = organisation ; part et référence de l’objet gardées', async () => {
    const { payment } = await ask({
      organizationId: ORGANIZATION_ID,
      target: {
        service: '',
        objectType: 'billing_invoice',
        objectId: SESSION_ID,
        part: 'balance',
        reference: 'FAC-2026-000012',
      },
      description: 'Facture de novembre',
    });
    expect(payment.subject.id).toBe(ORGANIZATION_ID);
    expect(payment.organizationId).toBe(ORGANIZATION_ID);
    expect(payment.target).toMatchObject({ part: 'balance', reference: 'FAC-2026-000012' });
    // Référence absente du libellé : ajoutée pour le payeur chez le prestataire.
    expect(provider().checkouts.at(-1)?.description).toBe('KSP - Facture de novembre (FAC-2026-000012)');
  });

  it('idempotent par (service, clé) : même paiement ; autre demande avec la clé : refusée', async () => {
    const first = await ask();
    const again = await ask();
    expect(again).toMatchObject({ created: false, payment: { id: first.payment.id } });
    expect(provider().checkouts).toHaveLength(1);
    const otherAmount = await rejection(ask({ amount: { amount: 15000, currency: 'XOF' } }));
    expect(otherAmount.code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
    const otherPayer = await rejection(ask({ customerId: OTHER_CUSTOMER_ID }));
    expect(otherPayer.code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
    // La clé est propre au service demandeur : la même clé de billing est une autre demande.
    const billing = await ask({}, 'billing');
    expect(billing.created).toBe(true);
    expect(billing.payment.target?.service).toBe('billing');
  });

  it('page encore ouverte pour le même objet et le même montant : réutilisée', async () => {
    const first = await ask();
    const retry = await ask({ idempotencyKey: `cleaning_session:${SESSION_ID}:2` });
    expect(retry).toMatchObject({ created: false, payment: { id: first.payment.id } });
    expect(provider().checkouts).toHaveLength(1);
  });

  it('autre montant (ou autre payeur) pour le même objet : l’ancienne page est remplacée', async () => {
    const first = await ask();
    const other = await ask({
      idempotencyKey: `cleaning_session:${SESSION_ID}:2`,
      amount: { amount: 6000, currency: 'XOF' },
    });
    expect(other.created).toBe(true);
    expect(other.payment.id).not.toBe(first.payment.id);
    expect((await payments().findById(first.payment.id))?.status).toBe('cancelled');
    expect(provider().cancelled).toContain(first.payment.providerTransactionId);
    const otherPayer = await ask({
      idempotencyKey: `cleaning_session:${SESSION_ID}:3`,
      amount: { amount: 6000, currency: 'XOF' },
      customerId: OTHER_CUSTOMER_ID,
    });
    expect(otherPayer.created).toBe(true);
    expect((await payments().findById(other.payment.id))?.status).toBe('cancelled');
  });

  it('objets distincts : pages indépendantes ; une recharge ordinaire ne touche pas la page d’un objet', async () => {
    const session = await ask();
    const other = await ask({
      idempotencyKey: `cleaning_session:${OTHER_SESSION_ID}:1`,
      target: { ...request().target!, objectId: OTHER_SESSION_ID },
    });
    expect(other.created).toBe(true);
    // Recharge du même titulaire et du même montant demandée par wallet : nouvelle page, celle de
    // l'objet reste ouverte (ni réutilisée ni annulée).
    const topUp = await runWithContext(
      {
        correlationId: 'c-test',
        callerService: 'wallet',
        user: { userId: CUSTOMER_ID, sessionId: 's', activeContext: 'personal', roles: [], mfa: false },
      },
      () =>
        useCases.createTopUpPayment.execute({
          idempotencyKey: 'topup-key-0001',
          amount: { amount: 12000, currency: 'XOF' },
        }),
    );
    expect(topUp.created).toBe(true);
    expect(topUp.payment.target).toBeNull();
    expect((await payments().findById(session.payment.id))?.status).toBe('pending');
    // Et la demande suivante pour la séance ne réutilise pas la recharge ordinaire.
    const retry = await ask({ idempotencyKey: `cleaning_session:${SESSION_ID}:2` });
    expect(retry.payment.id).toBe(session.payment.id);
  });

  it('échéance demandée gardée ; entre 15 minutes et 7 jours après la création', async () => {
    const now = deps.clock.now().getTime();
    const at = (ms: number) => new Date(now + ms).toISOString();
    const { payment } = await ask({ expiresAt: at(2 * 24 * 60 * MINUTE) });
    expect(payment.expiresAt.toISOString()).toBe(at(2 * 24 * 60 * MINUTE));
    for (const expiresAt of [at(14 * MINUTE), at(7 * 24 * 60 * MINUTE + 1000), 'demain', '2026-11-30']) {
      const error = await rejection(ask({ idempotencyKey: 'cleaning:bornes:1', expiresAt }));
      expect(error.code).toBe('PAYMENT_VALIDATION_FAILED');
      expect(error.details).toEqual({ field: 'expiresAt' });
    }
    const shortest = await ask({
      idempotencyKey: 'cleaning:bornes:2',
      target: { ...request().target!, objectId: OTHER_SESSION_ID },
      expiresAt: at(15 * MINUTE),
    });
    expect(shortest.payment.expiresAt.toISOString()).toBe(at(15 * MINUTE));
  });

  it('validation : PAYMENT_VALIDATION_FAILED avec details.field', async () => {
    const target = request().target!;
    const cases: [Partial<Request>, string][] = [
      [{ idempotencyKey: 'court' }, 'idempotencyKey'],
      [{ idempotencyKey: 'clé invalide!' }, 'idempotencyKey'],
      [{ idempotencyKey: 'x'.repeat(101) }, 'idempotencyKey'],
      [{ customerId: '' }, 'customerId'],
      [{ customerId: 'pas-un-uuid' }, 'customerId'],
      [{ organizationId: 'pas-un-uuid' }, 'organizationId'],
      [{ amount: undefined }, 'amount'],
      [{ amount: { amount: 0, currency: 'XOF' } }, 'amount'],
      [{ amount: { amount: 1_000_000_001, currency: 'XOF' } }, 'amount'],
      [{ amount: { amount: 12.5, currency: 'XOF' } }, 'amount'],
      [{ amount: { amount: 12000, currency: 'EUR' } }, 'amount'],
      [{ target: undefined }, 'target'],
      [{ target: { ...target, objectType: 'ab' } }, 'target.objectType'],
      [{ target: { ...target, objectType: 'Cleaning_Session' } }, 'target.objectType'],
      [{ target: { ...target, objectType: 'x'.repeat(51) } }, 'target.objectType'],
      [{ target: { ...target, objectId: 'pas-un-uuid' } }, 'target.objectId'],
      [{ target: { ...target, part: 'Acompte' } }, 'target.part'],
      [{ target: { ...target, reference: '  ' } }, 'target.reference'],
      [{ target: { ...target, reference: 'r'.repeat(61) } }, 'target.reference'],
      [{ description: '' }, 'description'],
      [{ description: 'd'.repeat(141) }, 'description'],
    ];
    for (const [overrides, field] of cases) {
      const error = await rejection(ask(overrides));
      expect({ field, code: error.code, details: error.details }).toEqual({
        field,
        code: 'PAYMENT_VALIDATION_FAILED',
        details: { field },
      });
    }
    expect(payments().rows.size).toBe(0);
    // Bornes acceptées.
    const ok = await ask({
      idempotencyKey: 'a:b_c-1234',
      amount: { amount: 1_000_000_000, currency: 'XOF' },
      target: { ...target, objectType: 'abc', reference: 'r'.repeat(60) },
      description: 'd'.repeat(140),
    });
    expect(ok.created).toBe(true);
  });

  it('réservé aux services de PAYMENT_DIRECT_CALLERS (jeton de service)', async () => {
    for (const service of ['wallet', 'gateway', 'recovery']) {
      expect((await rejection(ask({}, service))).code).toBe('PAYMENT_CALLER_FORBIDDEN');
    }
    deps.settings.directCallers = ['billing'];
    expect((await rejection(ask())).code).toBe('PAYMENT_CALLER_FORBIDDEN');
    expect(payments().rows.size).toBe(0);
  });

  it('prestataire en panne : paiement gardé sans page, la même clé la redemande', async () => {
    provider().down = true;
    expect((await rejection(ask())).code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    provider().down = false;
    const retry = await ask();
    expect(retry.created).toBe(false);
    expect(retry.payment.checkoutUrl).toEqual(expect.stringContaining('https://'));
  });

  it('réussite : payment.intent.succeeded porte l’objet visé ; relu par wallet comme une recharge', async () => {
    const { payment } = await ask({ organizationId: ORGANIZATION_ID });
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
    expect(payments().outbox.at(-1)).toEqual({
      type: 'payment.intent.succeeded',
      payload: expect.objectContaining({
        paymentId: payment.id,
        subjectType: 'wallet_top_up',
        subjectId: ORGANIZATION_ID,
        part: null,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        amount: { amount: 12000, currency: 'XOF' },
        target: {
          service: 'cleaning',
          objectType: 'cleaning_session',
          objectId: SESSION_ID,
          part: null,
          reference: 'séance 3/15',
        },
      }),
    });
    const read = await asService('wallet', () => useCases.getTopUpPayment.execute(payment.id));
    expect(read).toMatchObject({ payment: { status: 'succeeded' }, receivedAmount: 12000 });
  });
});
