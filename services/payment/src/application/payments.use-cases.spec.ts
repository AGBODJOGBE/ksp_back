import { type AppError } from '@ksp/platform';
import { type PaymentIntent } from '../domain/payment-intent';
import {
  asCustomer,
  asService,
  asStaff,
  CUSTOMER_ID,
  FakeProvider,
  type FixedClock,
  INVOICE_ID,
  invoiceDue,
  type InMemoryDues,
  type InMemoryNotificationLog,
  type InMemoryPayments,
  makeDeps,
  MISSION_ID,
  missionDue,
  ORGANIZATION_ID,
  OTHER_CUSTOMER_ID,
  type RecordingAlerts,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const KEY = 'pay-key-0001';

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('paiement en ligne (cas d’usage)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const payments = () => deps.payments as InMemoryPayments;
  const dues = () => deps.dues as InMemoryDues;
  const provider = () => deps.provider as FakeProvider;
  const clock = () => deps.clock as FixedClock;
  const alerts = () => deps.alerts as RecordingAlerts;

  beforeEach(() => {
    deps = makeDeps();
    useCases = createUseCases(deps);
    dues().missions.set(MISSION_ID, missionDue());
    dues().invoices.set(INVOICE_ID, invoiceDue());
  });

  const createMission = (part = 'deposit', key = KEY, userId = CUSTOMER_ID) =>
    asCustomer(
      () =>
        useCases.createPayment.execute({
          subjectType: 'cleaning_mission',
          subjectId: MISSION_ID,
          part,
          idempotencyKey: key,
        }),
      userId,
    );

  const notify = (transactionId: string, signature = 'valid') =>
    asService('gateway', () =>
      useCases.receiveProviderNotification.execute({
        provider: 'fedapay',
        payload: Buffer.from(
          JSON.stringify({ name: 'transaction.approved', entity: { id: Number(transactionId) } }),
        ),
        signature,
      }),
    );

  describe('création', () => {
    it('acompte d’une mission : montant lu dans cleaning, page de paiement du prestataire', async () => {
      const { payment, created } = await createMission();
      expect(created).toBe(true);
      expect(payment).toMatchObject({
        status: 'pending',
        amount: 15000,
        customerId: CUSTOMER_ID,
        organizationId: null,
        subject: { type: 'cleaning_mission', id: MISSION_ID, part: 'deposit', reference: null },
        checkoutUrl: 'https://process.fedapay.com/tok1',
        providerTransactionId: '1001',
      });
      expect(payment.expiresAt.getTime() - payment.createdAt.getTime()).toBe(30 * 60_000);
      expect(provider().checkouts[0]).toMatchObject({
        amount: 15000,
        currency: 'XOF',
        description: 'KSP Nettoyage - Acompte',
        returnUrl: `https://ksp.bj/mon-espace/paiements/${payment.id}`,
      });
    });

    it('solde : le reste dû', async () => {
      const { payment } = await createMission('balance');
      expect(payment.amount).toBe(50000);
    });

    it('idempotente : même clé → même paiement, aucun nouvel appel au prestataire', async () => {
      const first = await createMission();
      const second = await createMission();
      expect(second).toEqual({ payment: first.payment, created: false });
      expect(provider().checkouts).toHaveLength(1);
    });

    it('même clé pour un autre objet : 409', async () => {
      await createMission('deposit');
      expect((await rejection(createMission('balance'))).code).toBe('PAYMENT_IDEMPOTENCY_KEY_REUSED');
    });

    it('un paiement en attente pour le même objet et le même montant est réutilisé', async () => {
      const first = await createMission('deposit', 'pay-key-0001');
      const second = await createMission('deposit', 'pay-key-0002');
      expect(second.created).toBe(false);
      expect(second.payment.id).toBe(first.payment.id);
    });

    it('montant changé entre-temps (paiement manuel) : nouveau paiement', async () => {
      const first = await createMission('balance', 'pay-key-0001');
      dues().missions.set(MISSION_ID, missionDue({ remainingDue: 20000 }));
      const second = await createMission('balance', 'pay-key-0002');
      expect(second.created).toBe(true);
      expect(second.payment.id).not.toBe(first.payment.id);
      expect(second.payment.amount).toBe(20000);
      // L'ancienne page ne doit plus être payée : paiement annulé, transaction annulée chez le prestataire.
      expect(await payments().findById(first.payment.id)).toMatchObject({
        status: 'cancelled',
        failureReason: 'cancelled',
      });
      expect(provider().cancelled).toEqual(['1001']);
      expect(payments().outbox).toEqual([
        expect.objectContaining({
          type: 'payment.intent.failed',
          payload: expect.objectContaining({ paymentId: first.payment.id, status: 'cancelled' }),
        }),
      ]);
    });

    it('mission d’un autre client : 404, sans rien révéler', async () => {
      const error = await rejection(createMission('deposit', KEY, OTHER_CUSTOMER_ID));
      expect(error.code).toBe('PAYMENT_SUBJECT_NOT_FOUND');
    });

    it('mission inconnue : 404', async () => {
      dues().missions.clear();
      expect((await rejection(createMission())).code).toBe('PAYMENT_SUBJECT_NOT_FOUND');
    });

    it('mission d’entreprise : réglée par sa facture', async () => {
      dues().missions.set(MISSION_ID, missionDue({ organizationId: ORGANIZATION_ID }));
      expect((await rejection(createMission())).code).toBe('PAYMENT_VIA_INVOICE');
    });

    it('mission annulée, acompte déjà reçu : refus', async () => {
      dues().missions.set(MISSION_ID, missionDue({ status: 'cancelled' }));
      expect((await rejection(createMission())).code).toBe('PAYMENT_SUBJECT_NOT_PAYABLE');
      dues().missions.set(MISSION_ID, missionDue({ depositDue: 0 }));
      expect((await rejection(createMission('deposit', 'pay-key-0009'))).code).toBe('PAYMENT_NOTHING_DUE');
    });

    it('part obligatoire pour une mission, interdite pour une facture ; clé valide', async () => {
      expect((await rejection(createMission('all'))).details).toEqual({ field: 'part' });
      const invoiceWithPart = asCustomer(() =>
        useCases.createPayment.execute({
          subjectType: 'billing_invoice',
          subjectId: INVOICE_ID,
          part: 'deposit',
          idempotencyKey: KEY,
        }),
      );
      expect((await rejection(invoiceWithPart)).details).toEqual({ field: 'part' });
      expect((await rejection(createMission('deposit', 'court'))).details).toEqual({
        field: 'idempotencyKey',
      });
    });

    it('facture d’organisation : membre dans le contexte de l’organisation, reste dû de billing', async () => {
      const { payment } = await asCustomer(
        () =>
          useCases.createPayment.execute({
            subjectType: 'billing_invoice',
            subjectId: INVOICE_ID,
            part: '',
            idempotencyKey: KEY,
          }),
        OTHER_CUSTOMER_ID,
        ORGANIZATION_ID,
      );
      expect(payment).toMatchObject({
        amount: 160000,
        customerId: OTHER_CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        subject: { type: 'billing_invoice', part: null, reference: 'FAC-2026-000042' },
      });
    });

    it('facture d’organisation hors de son contexte (personnel) : 404', async () => {
      const error = await rejection(
        asCustomer(() =>
          useCases.createPayment.execute({
            subjectType: 'billing_invoice',
            subjectId: INVOICE_ID,
            part: '',
            idempotencyKey: KEY,
          }),
        ),
      );
      expect(error.code).toBe('PAYMENT_SUBJECT_NOT_FOUND');
    });

    it('facture déjà payée : rien à payer', async () => {
      dues().invoices.set(INVOICE_ID, invoiceDue({ status: 'paid', balance: 0 }));
      const error = await rejection(
        asCustomer(
          () =>
            useCases.createPayment.execute({
              subjectType: 'billing_invoice',
              subjectId: INVOICE_ID,
              part: '',
              idempotencyKey: KEY,
            }),
          CUSTOMER_ID,
          ORGANIZATION_ID,
        ),
      );
      expect(error.code).toBe('PAYMENT_NOTHING_DUE');
    });

    it('prestataire en panne : 503, puis la même clé reprend la page', async () => {
      provider().down = true;
      expect((await rejection(createMission())).code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect([...payments().rows.values()][0]).toMatchObject({ status: 'pending', checkoutUrl: null });
      provider().down = false;
      const { payment } = await createMission();
      expect(payment.checkoutUrl).toBe('https://process.fedapay.com/tok1');
      expect(payments().rows.size).toBe(1);
    });
  });

  describe('confirmation par le prestataire', () => {
    let payment: PaymentIntent;

    beforeEach(async () => {
      payment = (await createMission()).payment;
    });

    it('notification signée : transaction relue, paiement réussi, un seul événement', async () => {
      provider().set('1001', { status: 'approved' });
      expect(await notify('1001')).toBe('applied');
      expect(await notify('1001')).toBe('no_change');
      const stored = await payments().findById(payment.id);
      expect(stored).toMatchObject({ status: 'succeeded', completedAt: clock().now() });
      expect(payments().outbox).toEqual([
        {
          type: 'payment.intent.succeeded',
          payload: {
            paymentId: payment.id,
            subjectType: 'cleaning_mission',
            subjectId: MISSION_ID,
            part: 'deposit',
            subjectReference: null,
            customerId: CUSTOMER_ID,
            organizationId: null,
            amount: { amount: 15000, currency: 'XOF' },
            provider: 'fedapay',
            method: 'mobile_money_online',
            providerReference: 'trx_1',
            succeededAt: '2026-11-02T09:00:00.000Z',
          },
        },
      ]);
      expect((deps.notifications as InMemoryNotificationLog).entries.map((e) => e.outcome)).toEqual([
        'applied',
        'no_change',
      ]);
    });

    it('le contenu de la notification n’est pas cru : sans approbation chez le prestataire, rien ne change', async () => {
      expect(await notify('1001')).toBe('no_change');
      expect((await payments().findById(payment.id))!.status).toBe('pending');
      expect(payments().outbox).toEqual([]);
    });

    it('signature fausse : 400, rien n’est journalisé ni changé', async () => {
      provider().set('1001', { status: 'approved' });
      expect((await rejection(notify('1001', 'forged'))).code).toBe('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
      expect((await payments().findById(payment.id))!.status).toBe('pending');
    });

    it('notification réservée à la gateway', async () => {
      const call = asService('cleaning', () =>
        useCases.receiveProviderNotification.execute({
          provider: 'fedapay',
          payload: Buffer.from('{}'),
          signature: 'valid',
        }),
      );
      expect((await rejection(call)).code).toBe('PAYMENT_CALLER_FORBIDDEN');
    });

    it('transaction inconnue : sans effet (journalisée)', async () => {
      expect(await notify('9999')).toBe('unknown_transaction');
    });

    it('montant approuvé différent : amount_mismatch, alerte, aucun événement pour cleaning ni billing', async () => {
      provider().set('1001', { status: 'approved', amount: 100 });
      expect(await notify('1001')).toBe('amount_mismatch');
      expect((await payments().findById(payment.id))!.status).toBe('amount_mismatch');
      expect(payments().outbox).toEqual([]);
      expect(alerts().amountMismatches).toEqual([
        {
          paymentId: payment.id,
          transactionId: '1001',
          expectedAmount: 15000,
          approvedAmount: 100,
          currency: 'XOF',
        },
      ]);
    });

    it('montant différent puis rapprochement après 30 minutes : pas d’expiration', async () => {
      provider().set('1001', { status: 'approved', amount: 100 });
      clock().advance(2 * 60_000);
      expect(await useCases.reconcilePendingPayments.execute()).toMatchObject({ mismatched: 1 });
      expect(alerts().amountMismatches).toHaveLength(1);
      clock().advance(30 * 60_000);
      await useCases.reconcilePendingPayments.execute();
      expect(await payments().findById(payment.id)).toMatchObject({
        status: 'amount_mismatch',
        failureReason: null,
      });
      expect(provider().cancelled).toEqual([]);
      expect(payments().outbox).toEqual([]);
    });

    it('devise qui n’est pas établie comme XOF : amount_mismatch', async () => {
      provider().set('1001', { status: 'approved', currency: 'UNKNOWN' });
      expect(await notify('1001')).toBe('amount_mismatch');
      expect((await payments().findById(payment.id))!.status).toBe('amount_mismatch');
    });

    it('transaction relue qui n’est pas celle du paiement : ignorée et signalée', async () => {
      provider().set('1001', { status: 'approved', paymentId: '0192f1c4-0000-7000-8000-0000000000ff' });
      expect(await notify('1001')).toBe('transaction_mismatch');
      expect((await payments().findById(payment.id))!.status).toBe('pending');
      expect(alerts().transactionMismatches).toEqual([
        {
          paymentId: payment.id,
          expectedTransactionId: '1001',
          receivedTransactionId: '1001',
          receivedPaymentId: '0192f1c4-0000-7000-8000-0000000000ff',
        },
      ]);
      provider().set('1001', { paymentId: payment.id, transactionId: '1002' });
      expect(await notify('1001')).toBe('transaction_mismatch');
      expect(payments().outbox).toEqual([]);
    });

    it('refus chez le prestataire : échec et payment.intent.failed', async () => {
      provider().set('1001', { status: 'declined' });
      await notify('1001');
      expect(await payments().findById(payment.id)).toMatchObject({
        status: 'failed',
        failureReason: 'declined',
      });
      expect(payments().outbox[0]).toMatchObject({
        type: 'payment.intent.failed',
        payload: { status: 'failed' },
      });
    });

    it('expiration : transaction annulée chez le prestataire, puis paiement expiré', async () => {
      clock().advance(31 * 60_000);
      await useCases.reconcilePendingPayments.execute();
      expect(provider().cancelled).toEqual(['1001']);
      expect((await payments().findById(payment.id))!.status).toBe('expired');
    });

    it('réussite tardive : relue par le rapprochement pendant 24 heures, réussite et événement', async () => {
      clock().advance(31 * 60_000);
      await useCases.reconcilePendingPayments.execute();
      provider().set('1001', { status: 'approved' }); // la page avait été payée malgré l'annulation
      clock().advance(16 * 60_000); // relecture des paiements clos : toutes les 15 minutes
      expect(await useCases.reconcilePendingPayments.execute()).toMatchObject({ succeeded: 1 });
      expect((await payments().findById(payment.id))!.status).toBe('succeeded');
      expect(payments().outbox.map((e) => e.type)).toEqual([
        'payment.intent.failed',
        'payment.intent.succeeded',
      ]);
    });

    it('au-delà de la fenêtre de réussite tardive : plus relu', async () => {
      clock().advance(31 * 60_000);
      await useCases.reconcilePendingPayments.execute();
      provider().set('1001', { status: 'approved' });
      clock().advance(25 * 3_600_000);
      expect(await useCases.reconcilePendingPayments.execute()).toMatchObject({ examined: 0 });
      expect((await payments().findById(payment.id))!.status).toBe('expired');
    });

    it('réussite tardive après expiration : la réussite l’emporte', async () => {
      clock().advance(31 * 60_000);
      await useCases.reconcilePendingPayments.execute();
      expect((await payments().findById(payment.id))!.status).toBe('expired');
      provider().set('1001', { status: 'approved' });
      expect(await notify('1001')).toBe('applied');
      expect((await payments().findById(payment.id))!.status).toBe('succeeded');
      expect(payments().outbox.map((e) => e.type)).toEqual([
        'payment.intent.failed',
        'payment.intent.succeeded',
      ]);
    });
  });

  describe('consultation', () => {
    it('au retour du client : statut relu chez le prestataire, au plus une fois par intervalle', async () => {
      const { payment } = await createMission();
      provider().set('1001', { status: 'approved' });
      const read = await asCustomer(() => useCases.getMyPayment.execute(payment.id));
      expect(read.status).toBe('succeeded');
      expect(payments().outbox).toHaveLength(1);
    });

    it('prestataire injoignable : dernier statut connu', async () => {
      const { payment } = await createMission();
      provider().down = true;
      expect((await asCustomer(() => useCases.getMyPayment.execute(payment.id))).status).toBe('pending');
    });

    it('autre client : 404 ; membre de l’organisation payeuse dans son contexte : visible', async () => {
      const { payment } = await asCustomer(
        () =>
          useCases.createPayment.execute({
            subjectType: 'billing_invoice',
            subjectId: INVOICE_ID,
            part: '',
            idempotencyKey: KEY,
          }),
        CUSTOMER_ID,
        ORGANIZATION_ID,
      );
      const stranger = asCustomer(() => useCases.getMyPayment.execute(payment.id), OTHER_CUSTOMER_ID);
      expect((await rejection(stranger)).code).toBe('PAYMENT_NOT_FOUND');
      const member = await asCustomer(
        () => useCases.getMyPayment.execute(payment.id),
        OTHER_CUSTOMER_ID,
        ORGANIZATION_ID,
      );
      expect(member.id).toBe(payment.id);
      const list = await asCustomer(
        () => useCases.listMyPayments.execute({ page: { limit: 20, cursor: null }, status: '' }),
        OTHER_CUSTOMER_ID,
        ORGANIZATION_ID,
      );
      expect(list.items.map((p) => p.id)).toEqual([payment.id]);
    });

    it('back-office : rôle et double authentification exigés, filtres', async () => {
      await createMission();
      const list = await asStaff(() =>
        useCases.listPayments.execute({
          page: { limit: 20, cursor: null },
          status: 'pending',
          subjectType: 'cleaning_mission',
          subjectId: MISSION_ID,
          customerId: '',
          organizationId: '',
        }),
      );
      expect(list.items).toHaveLength(1);
      const all = {
        page: { limit: 20, cursor: null },
        status: '',
        subjectType: '',
        subjectId: '',
        customerId: '',
        organizationId: '',
      };
      expect(
        (await rejection(asStaff(() => useCases.listPayments.execute(all), 'cleaning_agent'))).code,
      ).toBe('AUTH_FORBIDDEN');
      expect(
        (await rejection(asStaff(() => useCases.listPayments.execute(all), 'finance_officer', false))).code,
      ).toBe('AUTH_MFA_REQUIRED');
    });
  });

  describe('rapprochement planifié', () => {
    it('plus de 50 paiements clos à relire : le paiement en attente est quand même traité', async () => {
      const { payment } = await createMission();
      const base = (await payments().findById(payment.id))!;
      for (let n = 0; n < 60; n += 1) {
        const id = `0192f1c4-0000-7000-8000-00000000e${String(n).padStart(3, '0')}`;
        payments().rows.set(id, {
          ...base,
          id,
          idempotencyKey: `closed-key-${n}`,
          status: 'expired',
          failureReason: 'expired',
          providerTransactionId: `closed-${n}`,
          createdAt: new Date(clock().now().getTime() - 3_600_000),
          completedAt: new Date(clock().now().getTime() - 60_000),
        });
      }
      provider().set('1001', { status: 'approved' });
      clock().advance(2 * 60_000);
      const counts = await useCases.reconcilePendingPayments.execute();
      expect(counts.examined).toBe(51); // 1 en attente + 50 clos (quota distinct)
      expect((await payments().findById(payment.id))!.status).toBe('succeeded');
    });

    it('paiements clos relus moins souvent (15 minutes) que les paiements en attente', async () => {
      const { payment } = await createMission();
      clock().advance(31 * 60_000);
      await useCases.reconcilePendingPayments.execute(); // expiré, relu à l'instant
      clock().advance(5 * 60_000);
      expect((await useCases.reconcilePendingPayments.execute()).examined).toBe(0);
      clock().advance(11 * 60_000);
      expect((await useCases.reconcilePendingPayments.execute()).examined).toBe(1);
      expect((await payments().findById(payment.id))!.status).toBe('expired');
    });

    it('notification perdue : réussite constatée en relisant le prestataire', async () => {
      const { payment } = await createMission();
      provider().set('1001', { status: 'approved' });
      clock().advance(2 * 60_000);
      expect(await useCases.reconcilePendingPayments.execute()).toMatchObject({ examined: 1, succeeded: 1 });
      expect((await payments().findById(payment.id))!.status).toBe('succeeded');
    });

    it('toujours en attente au-delà du délai : expiré', async () => {
      const { payment } = await createMission();
      clock().advance(31 * 60_000);
      expect(await useCases.reconcilePendingPayments.execute()).toMatchObject({ failed: 1 });
      expect(await payments().findById(payment.id)).toMatchObject({
        status: 'expired',
        failureReason: 'expired',
      });
    });
  });

  describe('simulation (développement)', () => {
    it('désactivée par défaut (production, prestataire réel)', async () => {
      const { payment } = await createMission();
      const call = asCustomer(() =>
        useCases.simulatePayment.execute({ paymentId: payment.id, outcome: 'succeeded' }),
      );
      expect((await rejection(call)).code).toBe('PAYMENT_SIMULATION_DISABLED');
    });

    it('prestataire simulé : la page du portail règle la transaction, confirmée par le même chemin', async () => {
      const simulated = new FakeProvider();
      Object.assign(simulated, {
        settle: async (id: string, outcome: 'succeeded' | 'failed') =>
          simulated.set(id, { status: outcome === 'succeeded' ? 'approved' : 'declined' }),
      });
      deps = makeDeps({ provider: simulated, settings: { ...makeDeps().settings, simulationEnabled: true } });
      useCases = createUseCases(deps);
      (deps.dues as InMemoryDues).missions.set(MISSION_ID, missionDue());
      const { payment } = await createMission();
      const settled = await asCustomer(() =>
        useCases.simulatePayment.execute({ paymentId: payment.id, outcome: 'succeeded' }),
      );
      expect(settled.status).toBe('succeeded');
      expect((deps.payments as InMemoryPayments).outbox.map((e) => e.type)).toEqual([
        'payment.intent.succeeded',
      ]);
      const other = asCustomer(
        () => useCases.simulatePayment.execute({ paymentId: payment.id, outcome: 'failed' }),
        OTHER_CUSTOMER_ID,
      );
      expect((await rejection(other)).code).toBe('PAYMENT_NOT_FOUND');
    });
  });
});
