import { type AppError } from '@ksp/platform';
import {
  asService,
  type FakeProvider,
  type FixedClock,
  type InMemoryLinks,
  type InMemoryPayments,
  makeDeps,
  type RecordingAlerts,
  STAFF_ID,
  asStaff,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const INSTALLMENT = '0192f1c4-0000-7000-8000-0000000e0001';
const LINK_KEY = 'link-key-0001';
const PAY_KEY = 'pay-key-0001';

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('liens de paiement (cas d’usage, ADR-040)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const payments = () => deps.payments as InMemoryPayments;
  const links = () => deps.links as InMemoryLinks;
  const provider = () => deps.provider as FakeProvider;
  const clock = () => deps.clock as FixedClock;
  const alerts = () => deps.alerts as RecordingAlerts;

  beforeEach(() => {
    deps = makeDeps();
    useCases = createUseCases(deps);
  });

  const request = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: LINK_KEY,
    subjectType: 'recovery_installment',
    subjectId: INSTALLMENT,
    reference: 'REC-2026-000123 E2',
    beneficiaryName: 'SARL Bénin Immo',
    description: 'Échéance 2 sur 6',
    amount: { amount: 25000, currency: 'XOF' },
    dueDate: '2026-11-30',
    expiresAt: new Date(clock().now().getTime() + 7 * 24 * 3_600_000).toISOString(),
    payerName: 'Koffi Adjovi',
    payerPhone: '+2290197000045',
    ...overrides,
  });

  const create = (overrides: Record<string, unknown> = {}, caller = 'recovery') =>
    asService(caller, () => useCases.createPaymentLink.execute(request(overrides) as never));

  const pay = (token: string, key = PAY_KEY) =>
    useCases.payPaymentLink.execute({ token, idempotencyKey: key });

  const approve = async (transactionId: string) => {
    provider().set(transactionId, { status: 'approved' });
    return asService('gateway', () =>
      useCases.receiveProviderNotification.execute({
        provider: 'fedapay',
        payload: Buffer.from(
          JSON.stringify({ name: 'transaction.approved', entity: { id: Number(transactionId) } }),
        ),
        signature: 'valid',
      }),
    );
  };

  describe('création par l’émetteur', () => {
    it('lien actif, jeton long et adresse publique ; seule l’empreinte du jeton est enregistrée', async () => {
      const { view, created } = await create();
      expect(created).toBe(true);
      expect(view.status).toBe('active');
      expect(view.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(view.url).toBe(`https://ksp.bj/payer/${view.token}`);
      expect(view.link).toMatchObject({ issuer: 'recovery', amount: 25000, payerPhone: '+2290197000045' });
      expect(JSON.stringify([...links().rows.values()])).not.toContain(view.token);
      expect([...links().hashes.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejeu de la même clé : même lien, même jeton ; clé réutilisée pour un autre objet : 409', async () => {
      const first = await create();
      const again = await create();
      expect(again).toMatchObject({ created: false });
      expect(again.view.token).toBe(first.view.token);
      const reused = await rejection(create({ amount: { amount: 30000, currency: 'XOF' } }));
      expect(reused.code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
    });

    it('réservé aux émetteurs autorisés', async () => {
      expect((await rejection(create({}, 'cleaning'))).code).toBe('PAYMENT_CALLER_FORBIDDEN');
    });

    it.each([
      ['subjectType', { subjectType: 'billing_invoice' }],
      ['subjectType', { subjectType: 'Recovery' }],
      ['amount', { amount: { amount: 10.5, currency: 'XOF' } }],
      ['amount', { amount: { amount: 100, currency: 'EUR' } }],
      ['expiresAt', { expiresAt: new Date('2026-11-02T09:30:00Z').toISOString() }],
      ['expiresAt', { expiresAt: '2027-12-31T00:00:00Z' }],
      ['dueDate', { dueDate: '2026-02-30' }],
      ['payerPhone', { payerPhone: '0197000045' }],
      ['reference', { reference: '' }],
    ])('refuse un champ invalide (%s)', async (field, overrides) => {
      const error = await rejection(create(overrides));
      expect(error.code).toBe('PAYMENT_VALIDATION_FAILED');
      expect(error.details).toEqual({ field });
    });

    it('un seul lien payable par objet : révoquer avant d’en créer un autre', async () => {
      const { view } = await create();
      const second = await rejection(create({ idempotencyKey: 'link-key-0002' }));
      expect(second.code).toBe('PAYMENT_LINK_ALREADY_ACTIVE');
      await asService('recovery', () =>
        useCases.revokePaymentLink.execute({ linkId: view.link.id, reason: '' }),
      );
      expect((await create({ idempotencyKey: 'link-key-0002' })).created).toBe(true);
    });
  });

  describe('page publique', () => {
    it('résumé sans donnée personnelle ; jeton faux ou mal formé : 404', async () => {
      const { view } = await create();
      const summary = await useCases.getPublicPaymentLink.execute(view.token);
      expect(summary.status).toBe('active');
      expect((await rejection(useCases.getPublicPaymentLink.execute('x'.repeat(43)))).code).toBe(
        'PAYMENT_LINK_NOT_FOUND',
      );
      expect((await rejection(useCases.getPublicPaymentLink.execute('court'))).code).toBe(
        'PAYMENT_LINK_NOT_FOUND',
      );
    });

    it('paiement : essai sans payeur connecté, page du prestataire avec retour sur le lien', async () => {
      const { view } = await create();
      const { payment, created } = await pay(view.token);
      expect(created).toBe(true);
      expect(payment).toMatchObject({
        status: 'pending',
        amount: 25000,
        customerId: null,
        organizationId: null,
        paymentLinkId: view.link.id,
        subject: {
          type: 'recovery_installment',
          id: INSTALLMENT,
          part: null,
          reference: 'REC-2026-000123 E2',
        },
      });
      expect(provider().checkouts[0]).toMatchObject({
        description: 'KSP - Paiement REC-2026-000123 E2',
        returnUrl: view.url,
      });
      // Même clé : même essai ; autre clé : l’essai en attente est réutilisé (une seule page payable).
      expect((await pay(view.token)).payment.id).toBe(payment.id);
      expect(await pay(view.token, 'pay-key-0002')).toMatchObject({
        created: false,
        payment: { id: payment.id },
      });
      expect(provider().checkouts).toHaveLength(1);
    });

    it('réussite confirmée par le prestataire : payment.link.paid (jamais payment.intent.succeeded), lien payé', async () => {
      const { view } = await create();
      const { payment } = await pay(view.token);
      expect(await approve(payment.providerTransactionId!)).toBe('applied');
      expect(payments().outbox.map((e) => e.type)).toEqual(['payment.link.paid']);
      expect(payments().outbox[0]!.payload).toEqual({
        paymentLinkId: view.link.id,
        paymentId: payment.id,
        subjectType: 'recovery_installment',
        subjectId: INSTALLMENT,
        reference: 'REC-2026-000123 E2',
        amount: { amount: 25000, currency: 'XOF' },
        method: 'mobile_money_online',
        provider: 'fedapay',
        providerReference: 'trx_1',
        paidAt: clock().now().toISOString(),
      });
      expect((await useCases.getPublicPaymentLink.execute(view.token)).status).toBe('paid');
      expect((await rejection(pay(view.token, 'pay-key-0003'))).code).toBe('PAYMENT_LINK_ALREADY_PAID');
      // Objet réglé : plus de nouveau lien pour lui.
      await asService('recovery', () =>
        useCases.revokePaymentLink.execute({ linkId: view.link.id, reason: '' }),
      ).catch(() => undefined);
      expect((await rejection(create({ idempotencyKey: 'link-key-0009' }))).code).toBe(
        'PAYMENT_LINK_ALREADY_PAID',
      );
    });

    it('échec : aucun événement, le payeur peut réessayer', async () => {
      const { view } = await create();
      const { payment } = await pay(view.token);
      provider().set(payment.providerTransactionId!, { status: 'declined' });
      await useCases.getPublicPaymentLink.execute(view.token);
      expect(payments().outbox).toEqual([]);
      expect((await pay(view.token, 'pay-key-0002')).created).toBe(true);
    });

    it('écart de montant : bloque le lien (PAYMENT_UNDER_REVIEW) jusqu’au traitement par la finance', async () => {
      const { view } = await create();
      const { payment } = await pay(view.token);
      provider().set(payment.providerTransactionId!, { status: 'approved', amount: 100 });
      expect(await approve(payment.providerTransactionId!)).toBe('amount_mismatch');
      expect(payments().outbox).toEqual([]);
      expect((await useCases.getPublicPaymentLink.execute(view.token)).status).toBe('under_review');
      expect((await rejection(pay(view.token, 'pay-key-0002'))).code).toBe('PAYMENT_UNDER_REVIEW');
      expect(alerts().underReview).toHaveLength(1);
      await asStaff(() =>
        useCases.resolveAmountMismatch.execute({
          paymentId: payment.id,
          note: 'Remboursé',
          idempotencyKey: '',
        }),
      );
      expect((await pay(view.token, 'pay-key-0003')).created).toBe(true);
      expect(STAFF_ID).toBeDefined();
    });

    it('lien expiré ou révoqué : refusé ; une réussite tardive reste enregistrée', async () => {
      const { view } = await create();
      const { payment } = await pay(view.token);
      const revoked = await asService('recovery', () =>
        useCases.revokePaymentLink.execute({ linkId: view.link.id, reason: 'Dossier soldé' }),
      );
      expect(revoked.status).toBe('revoked');
      expect(payments().rows.get(payment.id)!.status).toBe('cancelled');
      expect((await rejection(pay(view.token, 'pay-key-0002'))).code).toBe('PAYMENT_LINK_REVOKED');
      // Réussite tardive sur la page encore ouverte : l’argent reçu est enregistré.
      await approve(payment.providerTransactionId!);
      expect(payments().outbox.map((e) => e.type)).toEqual(['payment.link.paid']);
      expect((await useCases.getPublicPaymentLink.execute(view.token)).status).toBe('paid');

      const other = await create({
        idempotencyKey: 'link-key-0005',
        subjectId: '0192f1c4-0000-7000-8000-0000000e0002',
      });
      clock().advance(8 * 24 * 3_600_000);
      expect((await rejection(pay(other.view.token))).code).toBe('PAYMENT_LINK_EXPIRED');
    });

    it('trop d’essais par heure : 429', async () => {
      deps = makeDeps({ settings: { ...makeDeps().settings, linkAttemptsPerHour: 2 } });
      useCases = createUseCases(deps);
      const { view } = await create();
      for (const key of ['pay-key-0001', 'pay-key-0002']) {
        const { payment } = await pay(view.token, key);
        provider().set(payment.providerTransactionId!, { status: 'declined' });
        await useCases.getPublicPaymentLink.execute(view.token);
      }
      expect((await rejection(pay(view.token, 'pay-key-0003'))).code).toBe('PAYMENT_LINK_TOO_MANY_ATTEMPTS');
      clock().advance(61 * 60_000);
      expect((await pay(view.token, 'pay-key-0004')).created).toBe(true);
    });
  });

  describe('émetteur', () => {
    it('ne voit que ses liens ; révocation rejouable, refusée sur un lien payé', async () => {
      deps = makeDeps({ settings: { ...makeDeps().settings, linkIssuers: ['recovery', 'realestate'] } });
      useCases = createUseCases(deps);
      const { view } = await create();
      const hidden = await rejection(
        asService('realestate', () => useCases.getPaymentLink.execute(view.link.id)),
      );
      expect(hidden.code).toBe('PAYMENT_LINK_NOT_FOUND');
      const seen = await asService('recovery', () => useCases.getPaymentLink.execute(view.link.id));
      expect(seen.url).toBe(view.url);

      const { payment } = await pay(view.token);
      await approve(payment.providerTransactionId!);
      const refused = await rejection(
        asService('recovery', () => useCases.revokePaymentLink.execute({ linkId: view.link.id, reason: '' })),
      );
      expect(refused.code).toBe('PAYMENT_LINK_ALREADY_PAID');
    });
  });
});
