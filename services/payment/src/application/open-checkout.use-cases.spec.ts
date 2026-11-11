import { type AppError } from '@ksp/platform';
import {
  asCustomer,
  asService,
  CUSTOMER_ID,
  type FakeProvider,
  type FixedClock,
  INVOICE_ID,
  invoiceDue,
  type InMemoryDues,
  type InMemoryPayments,
  makeDeps,
  MISSION_ID,
  missionDue,
  ORGANIZATION_ID,
  OTHER_CUSTOMER_ID,
  type RecordingAlerts,
} from './testing/fakes';
import { createUseCases } from './use-cases';

/**
 * Une seule page payable par objet (ADR-048) : toutes parts et tous payeurs confondus, et jamais de
 * nouvelle page tant que l'ancienne peut encore être payée chez le prestataire.
 */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

const MINUTE = 60_000;

describe('page de paiement unique par objet (ADR-048)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const payments = () => deps.payments as InMemoryPayments;
  const dues = () => deps.dues as InMemoryDues;
  const provider = () => deps.provider as FakeProvider;
  const clock = () => deps.clock as FixedClock;
  const alerts = () => deps.alerts as RecordingAlerts;
  /** FedaPay : aucune annulation de transaction pour le marchand (ADR-031). */
  const withoutCancel = () =>
    Object.defineProperty(provider(), 'cancelTransaction', { value: undefined, configurable: true });

  beforeEach(() => {
    deps = makeDeps();
    useCases = createUseCases(deps);
    dues().missions.set(MISSION_ID, missionDue());
    dues().invoices.set(INVOICE_ID, invoiceDue());
  });

  const mission = (part: string, key: string, userId = CUSTOMER_ID) =>
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
  const invoice = (key: string, userId: string) =>
    asCustomer(
      () =>
        useCases.createPayment.execute({
          subjectType: 'billing_invoice',
          subjectId: INVOICE_ID,
          part: '',
          idempotencyKey: key,
        }),
      userId,
      ORGANIZATION_ID,
    );
  const reconcile = () => useCases.reconcilePendingPayments.execute();

  it('acompte en attente : la page du solde est refusée (409), jamais deux pages pour la mission', async () => {
    const deposit = await mission('deposit', 'pay-key-0001');
    const error = await rejection(mission('balance', 'pay-key-0002'));
    expect(error.code).toBe('PAYMENT_CHECKOUT_OPEN');
    expect(error.details).toMatchObject({ expiresAt: deposit.payment.expiresAt.toISOString() });
    expect(provider().checkouts).toHaveLength(1);
  });

  it('facture d’organisation : un second membre est refusé ; le même membre retrouve sa page', async () => {
    const first = await invoice('pay-key-0001', CUSTOMER_ID);
    expect((await rejection(invoice('pay-key-0002', OTHER_CUSTOMER_ID))).code).toBe('PAYMENT_CHECKOUT_OPEN');
    expect(await invoice('pay-key-0003', CUSTOMER_ID)).toMatchObject({
      created: false,
      payment: { id: first.payment.id },
    });
  });

  it('page refusée chez le prestataire (notification perdue) : relue, une nouvelle page est permise', async () => {
    await invoice('pay-key-0001', CUSTOMER_ID);
    provider().set('1001', { status: 'declined' });
    const second = await invoice('pay-key-0002', OTHER_CUSTOMER_ID);
    expect(second.created).toBe(true);
    expect((await payments().findById([...payments().rows.keys()][0]!))!.status).toBe('failed');
  });

  it('page jamais obtenue (prestataire en panne) : rien de payable, un autre payeur peut payer', async () => {
    provider().down = true;
    await rejection(invoice('pay-key-0001', CUSTOMER_ID));
    provider().down = false;
    const second = await invoice('pay-key-0002', OTHER_CUSTOMER_ID);
    expect(second.created).toBe(true);
    expect([...payments().rows.values()].filter((p) => p.status === 'pending')).toHaveLength(1);
  });

  it('deux créations simultanées (deux clics, deux membres) : une seule page', async () => {
    const results = await Promise.allSettled([
      invoice('pay-key-0001', CUSTOMER_ID),
      invoice('pay-key-0002', OTHER_CUSTOMER_ID),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as AppError).code).toBe('PAYMENT_CHECKOUT_OPEN');
    expect([...payments().rows.values()].filter((p) => p.status === 'pending')).toHaveLength(1);
  });

  describe('prestataire sans annulation (FedaPay)', () => {
    beforeEach(() => withoutCancel());

    it('page payable jusqu’à sa validité chez le prestataire (24 h par défaut), réutilisée jusque-là', async () => {
      const first = await mission('deposit', 'pay-key-0001');
      expect(first.payment.expiresAt.getTime() - first.payment.createdAt.getTime()).toBe(24 * 60 * MINUTE);
      clock().advance(2 * 60 * MINUTE);
      await reconcile();
      const again = await mission('deposit', 'pay-key-0002');
      expect(again).toMatchObject({ created: false, payment: { id: first.payment.id, status: 'pending' } });
    });

    it('montant dû changé : l’ancienne page encore payable, pas de nouvelle page (409)', async () => {
      await mission('balance', 'pay-key-0001');
      dues().missions.set(MISSION_ID, missionDue({ remainingDue: 20000 }));
      expect((await rejection(mission('balance', 'pay-key-0002'))).code).toBe('PAYMENT_CHECKOUT_OPEN');
      expect(provider().checkouts).toHaveLength(1);
    });

    it('validité écoulée : clos avec une alerte (page non annulée chez le prestataire), puis relu', async () => {
      const first = await mission('deposit', 'pay-key-0001');
      clock().advance(24 * 60 * MINUTE + MINUTE);
      expect(await reconcile()).toMatchObject({ failed: 1 });
      expect((await payments().findById(first.payment.id))!.status).toBe('expired');
      expect(alerts().checkoutsClosedUnconfirmed).toEqual([
        { paymentId: first.payment.id, transactionId: '1001', reason: 'expired' },
      ]);
      // Réussite tardive encore relue après la clôture.
      provider().set('1001', { status: 'approved' });
      clock().advance(16 * MINUTE);
      expect(await reconcile()).toMatchObject({ succeeded: 1 });
    });
  });

  it('annulation chez le prestataire impossible (panne) : le paiement reste en attente jusqu’à la validité', async () => {
    const first = await mission('deposit', 'pay-key-0001');
    provider().cancelTransaction = async () => {
      throw new Error('panne');
    };
    clock().advance(31 * MINUTE);
    await reconcile();
    expect((await payments().findById(first.payment.id))!.status).toBe('pending');
    expect((await rejection(mission('balance', 'pay-key-0002'))).code).toBe('PAYMENT_CHECKOUT_OPEN');
    clock().advance(24 * 60 * MINUTE);
    await reconcile();
    expect((await payments().findById(first.payment.id))!.status).toBe('expired');
    expect(alerts().checkoutsClosedUnconfirmed).toHaveLength(1);
  });

  it('liens : deux paiements simultanés du même lien, une seule page', async () => {
    const { view } = await asService('recovery', () =>
      useCases.createPaymentLink.execute({
        idempotencyKey: 'link-key-0001',
        subjectType: 'recovery_installment',
        subjectId: '0192f1c4-0000-7000-8000-0000000ee001',
        reference: 'REC-1',
        beneficiaryName: 'SARL Bénin Immo',
        description: 'Échéance 1',
        amount: { amount: 25000, currency: 'XOF' },
        dueDate: '',
        expiresAt: new Date(clock().now().getTime() + 7 * 24 * 60 * MINUTE).toISOString(),
        payerName: '',
        payerPhone: '',
      }),
    );
    const [a, b] = await Promise.all([
      useCases.payPaymentLink.execute({ token: view.token, idempotencyKey: 'pay-key-0001' }),
      useCases.payPaymentLink.execute({ token: view.token, idempotencyKey: 'pay-key-0002' }),
    ]);
    expect(a.payment.id).toBe(b.payment.id);
    expect([...payments().rows.values()].filter((p) => p.status === 'pending')).toHaveLength(1);
  });
});
