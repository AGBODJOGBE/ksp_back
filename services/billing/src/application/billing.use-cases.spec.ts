import { type AppError } from '@ksp/platform';
import { type BillingEventPayloads } from '@ksp/contracts';
import {
  as,
  asCustomer,
  asStaff,
  CUSTOMER_ID,
  ORGANIZATION_ID,
  ORGANIZATION_PROFILE,
  OTHER_CUSTOMER_ID,
  testWorld,
  type TestWorld,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const MISSION_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';
const event = (n: number) => `0192f1c4-7a2b-7c3d-8e4f-${String(9000 + n).padStart(12, '0')}`;
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: AppError) => error.code,
  );

const booking = (organizationId: string | null, eventId = event(1)) => ({
  eventId,
  type: 'cleaning.booking.confirmed' as const,
  occurredAt: '2026-10-23T08:00:00Z',
  payload: {
    requestId: event(50),
    quoteId: event(51),
    missionId: MISSION_ID,
    customerId: CUSTOMER_ID,
    organizationId,
    total: { amount: 300_000, currency: 'XOF' as const },
    plannedInterventions: 13,
    recurrence: { period: 'week' as const, visitsPerPeriod: 1, durationMonths: 3 },
    paymentPlan: { option: 'full' as const, timing: 'after' as const, method: 'cash' as const },
    depositAmount: { amount: 300_000, currency: 'XOF' as const },
    // 1er novembre à 00:00, heure du Bénin : trois mois civils entiers.
    startsAt: '2026-10-31T23:00:00.000Z',
  },
});

describe('facturation mensuelle des contrats d’entreprise', () => {
  let world: TestWorld;
  let useCases: ReturnType<typeof createUseCases>;
  const types = () => world.recorder.events.map((e) => e.type);
  const payload = <K extends keyof BillingEventPayloads>(type: K) =>
    world.recorder.events.find((e) => e.type === type)?.payload as BillingEventPayloads[K];

  beforeEach(async () => {
    world = testWorld();
    useCases = createUseCases(world);
    await useCases.registerContract.execute(booking(ORGANIZATION_ID));
  });

  it('contrat appris par cleaning.booking.confirmed ; doublon et particulier ignorés', async () => {
    expect(await useCases.registerContract.execute(booking(ORGANIZATION_ID))).toBe('duplicate');
    expect(await useCases.registerContract.execute(booking(null, event(2)))).toBe('ignored');
    expect(world.contracts.contracts.get(MISSION_ID)).toMatchObject({
      total: 300_000,
      durationMonths: 3,
      startsAt: new Date('2026-10-31T23:00:00.000Z'),
    });
  });

  it('émission à la fin du mois civil, idempotente, numérotée, échéance à 10 jours', async () => {
    world.clock.current = new Date('2026-11-30T22:59:00Z');
    expect(await useCases.issueDueInvoices.execute()).toEqual({ issued: 0, deferredContractIds: [] });
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    expect(await useCases.issueDueInvoices.execute()).toEqual({ issued: 1, deferredContractIds: [] });
    expect(await useCases.issueDueInvoices.execute()).toEqual({ issued: 0, deferredContractIds: [] });
    expect(types()).toEqual(['billing.invoice.issued']);
    expect(payload('billing.invoice.issued')).toMatchObject({
      invoiceNumber: 'FAC-2026-000001',
      organizationId: ORGANIZATION_ID,
      contractId: MISSION_ID,
      source: 'cleaning',
      total: { amount: 100_000, currency: 'XOF' },
      periodStart: '2026-10-31T23:00:00.000Z',
      periodEnd: '2026-11-30T23:00:00.000Z',
      issuedAt: '2026-12-01T09:00:00.000Z',
      dueAt: '2026-12-11T09:00:00.000Z',
    });
  });

  it('en-tête de l’organisation copié à l’émission ; une modification ultérieure ne le change pas', async () => {
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    expect(world.organizations.lookups).toEqual([[ORGANIZATION_ID]]);
    world.organizations.profiles.set(ORGANIZATION_ID, {
      ...ORGANIZATION_PROFILE,
      legalName: 'SARL Bénin Propre et Services',
      rccm: null,
    });
    world.clock.current = new Date('2027-01-01T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    const [november, december] = [...world.invoices.invoices.values()].sort(
      (a, b) => a.periodIndex - b.periodIndex,
    );
    expect(november?.organization).toEqual({
      legalName: 'SARL Bénin Propre',
      address: 'Lot 12, Haie Vive, Cotonou',
      ifu: '3201912345678',
      rccm: 'RB/COT/19 B 1234',
    });
    expect(december?.organization).toMatchObject({ legalName: 'SARL Bénin Propre et Services', rccm: null });
    const mine = await asCustomer(() => useCases.getMyInvoice.execute(november!.id));
    expect(mine.organization?.legalName).toBe('SARL Bénin Propre');
  });

  it('identity indisponible : aucune facture sans en-tête, émission reprise au passage suivant', async () => {
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    world.organizations.unavailable = true;
    await expect(useCases.issueDueInvoices.execute()).rejects.toThrow('identity indisponible');
    expect(world.invoices.invoices.size).toBe(0);
    expect(types()).toEqual([]);
    world.organizations.unavailable = false;
    world.clock.current = new Date('2026-12-01T09:15:00Z');
    expect(await useCases.issueDueInvoices.execute()).toEqual({ issued: 1, deferredContractIds: [] });
    expect(payload('billing.invoice.issued')).toMatchObject({
      issuedAt: '2026-12-01T09:15:00.000Z',
      dueAt: '2026-12-11T09:15:00.000Z',
    });
  });

  it('organisation introuvable dans identity : contrat reporté, les autres sont facturés', async () => {
    world.organizations.profiles.delete(ORGANIZATION_ID);
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    expect(await useCases.issueDueInvoices.execute()).toEqual({
      issued: 0,
      deferredContractIds: [MISSION_ID],
    });
    expect(world.invoices.invoices.size).toBe(0);
  });

  it('aucun mois à facturer : identity n’est pas appelé', async () => {
    world.clock.current = new Date('2026-11-15T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    expect(world.organizations.lookups).toEqual([]);
  });

  it('« impayée » à l’échéance, avec le nombre d’impayées du contrat', async () => {
    world.clock.current = new Date('2027-01-05T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    world.clock.current = new Date('2027-01-14T09:00:00Z');
    // Facture 1 émise le 5 janvier (rattrapage des deux mois) : échéance le 15.
    expect(await useCases.markOverdueInvoices.execute()).toEqual({ overdue: 0 });
    world.clock.current = new Date('2027-01-15T09:00:00Z');
    expect(await useCases.markOverdueInvoices.execute()).toEqual({ overdue: 2 });
    expect(await useCases.markOverdueInvoices.execute()).toEqual({ overdue: 0 });
    const overdue = world.recorder.events.filter((e) => e.type === 'billing.invoice.overdue');
    expect(overdue.map((e) => (e.payload as { overdueCount: number }).overdueCount)).toEqual([1, 2]);
  });

  it('paiement manuel : partiel puis complet, billing.invoice.paid avec les impayées restantes', async () => {
    world.clock.current = new Date('2026-12-16T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    world.clock.current = new Date('2026-12-26T09:00:00Z');
    await useCases.markOverdueInvoices.execute();
    const [invoice] = [...world.invoices.invoices.values()];
    const pay = (amount: number, method = 'cash') =>
      asStaff(() =>
        useCases.recordInvoicePayment.execute({ invoiceId: invoice!.id, amount, method, reference: 'R-1' }),
      );
    expect(await code(pay(100_001))).toBe('BILLING_PAYMENT_INVALID');
    expect(await code(pay(1000, 'cheque'))).toBe('BILLING_PAYMENT_INVALID');
    expect((await pay(40_000)).status).toBe('overdue');
    const paid = await pay(60_000, 'bank_transfer');
    expect(paid).toMatchObject({ status: 'paid', paidAt: new Date('2026-12-26T09:00:00Z') });
    expect(payload('billing.invoice.paid')).toMatchObject({ invoiceId: invoice!.id, overdueCount: 0 });
    expect(await code(pay(1))).toBe('BILLING_INVALID_TRANSITION');
  });

  it('jours de suspension déduits au prorata ; annulation : prorata jusqu’au jour de l’annulation', async () => {
    await useCases.suspendContract.execute({
      eventId: event(3),
      type: 'cleaning.contract.suspended',
      occurredAt: '2026-12-01T00:00:00Z',
      payload: {
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        cause: 'unpaid_invoices',
        unpaidCount: 2,
        threshold: 2,
        cancelledInterventionIds: [],
        releasedAgentIds: [],
        suspendedAt: '2026-12-01T00:00:00Z',
      },
    });
    world.clock.current = new Date('2026-12-06T00:00:00Z');
    // Novembre, non suspendu, est facturé en entier.
    expect(await useCases.issueDueInvoices.execute()).toEqual({ issued: 1, deferredContractIds: [] });
    await useCases.resumeContract.execute({
      eventId: event(4),
      type: 'cleaning.contract.resumed',
      occurredAt: '2026-12-10T00:00:00Z',
      payload: {
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        cause: 'unpaid_invoices',
        unpaidCount: 1,
        resumedAt: '2026-12-10T00:00:00Z',
        rescheduledCount: 1,
        failedCount: 0,
      },
    });
    await useCases.terminateContract.execute({
      eventId: event(5),
      type: 'cleaning.request.cancelled',
      occurredAt: '2027-01-20T00:00:00Z',
      payload: {
        requestId: event(50),
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        cancelledBy: 'supervisor',
        outcome: 'cancelled',
      },
    });
    world.clock.current = new Date('2027-03-01T00:00:00Z');
    await useCases.issueDueInvoices.execute();
    // Décembre : 9 jours suspendus (1er au 9) ; janvier : 19 jours jusqu'à l'annulation du 20.
    expect([...world.invoices.invoices.values()].map((i) => [i.periodIndex, i.total])).toEqual([
      [1, 100_000],
      [2, 70_968],
      [3, 61_290],
    ]);
  });

  it('client : factures de son organisation active seulement ; autre client : 404', async () => {
    world.clock.current = new Date('2026-12-06T00:00:00Z');
    await useCases.issueDueInvoices.execute();
    const [invoice] = [...world.invoices.invoices.values()];
    const mine = await asCustomer(() =>
      useCases.listMyInvoices.execute({ page: { limit: 20, cursor: null }, status: '' }),
    );
    expect(mine.items.map((i) => i.id)).toEqual([invoice!.id]);
    const personal = await asCustomer(
      () => useCases.listMyInvoices.execute({ page: { limit: 20, cursor: null }, status: '' }),
      'personal',
    );
    expect(personal.items).toEqual([]);
    expect(await code(as(OTHER_CUSTOMER_ID, () => useCases.getMyInvoice.execute(invoice!.id)))).toBe(
      'BILLING_INVOICE_NOT_FOUND',
    );
    expect(
      await code(
        asCustomer(() =>
          useCases.listMyInvoices.execute({ page: { limit: 20, cursor: null }, status: 'late' }),
        ),
      ),
    ).toBe('BILLING_VALIDATION_FAILED');
  });

  it('back-office : rôles et double authentification exigés ; réglages réservés', async () => {
    const list = () =>
      useCases.listInvoices.execute({
        page: { limit: 20, cursor: null },
        status: '',
        customerId: '',
        organizationId: '',
        contractId: MISSION_ID,
      });
    expect(await code(asCustomer(list))).toBe('AUTH_FORBIDDEN');
    expect(await code(as(CUSTOMER_ID, list, { roles: ['finance_officer'] }))).toBe('AUTH_MFA_REQUIRED');
    for (const role of ['finance_officer', 'cleaning_supervisor', 'cleaning_admin', 'super_admin']) {
      expect(await code(asStaff(list, role))).toBe('ok');
    }
    expect(
      await code(
        asStaff(() => useCases.updateSettings.execute({ paymentTermDays: 15 }), 'cleaning_supervisor'),
      ),
    ).toBe('AUTH_FORBIDDEN');
    expect(
      await code(asStaff(() => useCases.updateSettings.execute({ paymentTermDays: 0 }), 'cleaning_admin')),
    ).toBe('BILLING_VALIDATION_FAILED');
    const saved = await asStaff(
      () => useCases.updateSettings.execute({ paymentTermDays: 15 }),
      'cleaning_admin',
    );
    expect(saved).toMatchObject({ paymentTermDays: 15 });
    world.clock.current = new Date('2026-12-06T00:00:00Z');
    await useCases.issueDueInvoices.execute();
    expect(payload('billing.invoice.issued').dueAt).toBe('2026-12-21T00:00:00.000Z');
  });
});
