import { type AppError, runWithContext } from '@ksp/platform';
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

  it('nom de la prestation repris dans le libellé de la facture (ADR-035)', async () => {
    const named = booking(ORGANIZATION_ID, event(3));
    named.payload.missionId = event(60);
    await useCases.registerContract.execute({
      ...named,
      payload: { ...named.payload, serviceName: 'Nettoyage de bureaux' },
    });
    expect(world.contracts.contracts.get(event(60))!.serviceName).toBe('Nettoyage de bureaux');
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    const labels = [...world.invoices.invoices.values()].map((invoice) => invoice.lines[0]!.label);
    expect(labels.sort()).toEqual([
      'Nettoyage de bureaux — novembre 2026 : 30 jours sur 30',
      'Prestation de nettoyage — novembre 2026 : 30 jours sur 30',
    ]);
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

  it('paiement manuel idempotent : même clé → un seul paiement, rejoué tel quel', async () => {
    world.clock.current = new Date('2026-12-06T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    const [invoice] = [...world.invoices.invoices.values()];
    const pay = (amount: number, idempotencyKey?: string) =>
      asStaff(() =>
        useCases.recordInvoicePayment.execute({
          invoiceId: invoice!.id,
          amount,
          method: 'cash',
          reference: 'R-1',
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        }),
      );
    const first = await pay(40_000, 'paiement-cle-0001');
    expect(first.payments).toEqual([
      expect.objectContaining({ amount: 40_000, idempotencyKey: 'paiement-cle-0001' }),
    ]);
    const again = await pay(40_000, 'paiement-cle-0001');
    expect(again.payments).toHaveLength(1);
    expect(again.version).toBe(first.version);
    // Rejeu sans nouveau contrôle : même avec un autre montant, la facture est renvoyée telle quelle.
    expect((await pay(999_999, 'paiement-cle-0001')).payments).toHaveLength(1);
    // Autre clé, ou sans clé (front existant) : nouveaux paiements.
    expect((await pay(10_000, 'paiement-cle-0002')).payments).toHaveLength(2);
    expect((await pay(10_000)).payments).toHaveLength(3);
    expect((await pay(10_000, '')).payments).toHaveLength(4);
    // Facture payée ensuite : un rejeu de clé reste accepté, un nouveau paiement non.
    const paid = await pay(30_000, 'paiement-cle-0003');
    expect(paid.status).toBe('paid');
    expect((await pay(30_000, 'paiement-cle-0003')).status).toBe('paid');
    expect(await code(pay(1, 'paiement-cle-0004'))).toBe('BILLING_INVALID_TRANSITION');
    expect(await code(pay(1, 'court'))).toBe('BILLING_VALIDATION_FAILED');
    expect(world.recorder.events.filter((e) => e.type === 'billing.invoice.paid')).toHaveLength(1);
  });

  it('paiement manuel : envoi concurrent de la même clé, l’écriture perdante rejoue', async () => {
    world.clock.current = new Date('2026-12-06T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    const [invoice] = [...world.invoices.invoices.values()];
    const input = {
      invoiceId: invoice!.id,
      amount: 40_000,
      method: 'cash',
      reference: '',
      idempotencyKey: 'paiement-cle-0005',
    };
    // Le premier envoi lit la facture, puis le second est enregistré avant lui.
    const original = world.invoices.findById.bind(world.invoices);
    let reads = 0;
    world.invoices.findById = async (id: string) => {
      const found = await original(id);
      reads += 1;
      if (reads === 1) await asStaff(() => useCases.recordInvoicePayment.execute(input));
      return found;
    };
    const result = await asStaff(() => useCases.recordInvoicePayment.execute(input));
    world.invoices.findById = original;
    expect(result.payments).toHaveLength(1);
    expect((await original(invoice!.id))!.payments).toHaveLength(1);
  });

  it('back-office : filtre par période facturée (dates au Bénin, bornes incluses, fin exclusive en base)', async () => {
    world.clock.current = new Date('2027-02-02T00:00:00Z');
    await useCases.issueDueInvoices.execute();
    const list = (periodFrom: string, periodTo: string) =>
      asStaff(() =>
        useCases.listInvoices.execute({
          page: { limit: 20, cursor: null },
          status: '',
          customerId: '',
          organizationId: '',
          contractId: '',
          periodFrom,
          periodTo,
        }),
      );
    const months = async (from: string, to: string) =>
      (await list(from, to)).items.map((i) => i.periodIndex).sort();
    // Novembre : 1er novembre 00:00 → 1er décembre 00:00 (borne exclusive), heure du Bénin.
    const november = [...world.invoices.invoices.values()].find((i) => i.periodIndex === 1)!;
    expect(november.periodEnd.toISOString()).toBe('2026-11-30T23:00:00.000Z');
    expect(await months('2026-12-01', '2026-12-31')).toEqual([2]);
    expect(await months('2026-11-30', '2026-12-01')).toEqual([1, 2]);
    expect(await months('', '2026-11-30')).toEqual([1]);
    expect(await months('2027-01-31', '')).toEqual([3]);
    expect(await months('', '')).toEqual([1, 2, 3]);
    expect(await months('2027-02-01', '2027-12-31')).toEqual([]);
    for (const [from, to] of [
      ['2026-02-30', ''],
      ['2026-13-01', ''],
      ['01/12/2026', ''],
      ['2026-12-31', '2026-12-01'],
    ]) {
      expect(await code(list(from!, to!))).toBe('BILLING_VALIDATION_FAILED');
    }
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

  it('montant recalculé sous le verrou du contrat : un changement entre la lecture et l’émission compte (ADR-049)', async () => {
    // La tâche lit le contrat avant la suspension ; la suspension est enregistrée avant l'émission.
    const stale = await world.contracts.listOpen();
    world.contracts.listOpen = async () => stale;
    await useCases.suspendContract.execute({
      eventId: event(30),
      type: 'cleaning.contract.suspended',
      occurredAt: '2026-11-16T00:00:00Z',
      payload: {
        missionId: MISSION_ID,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        cause: 'unpaid_invoices',
        unpaidCount: 2,
        threshold: 2,
        cancelledInterventionIds: [],
        releasedAgentIds: [],
        // 16 novembre à 00:00 au Bénin : 15 jours sur 30 suspendus.
        suspendedAt: '2026-11-15T23:00:00Z',
      },
    });
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    expect([...world.invoices.invoices.values()].map((i) => i.total)).toEqual([50_000]);
  });

  it('numéro de facture : année de la période au Bénin, même émise l’année suivante (ADR-049)', async () => {
    world.clock.current = new Date('2027-01-02T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    expect([...world.invoices.invoices.values()].map((i) => [i.periodIndex, i.number])).toEqual([
      [1, 'FAC-2026-000001'],
      [2, 'FAC-2026-000002'],
    ]);
  });

  it('prestation ponctuelle : facturée en une fois, sur la facture du mois du passage (ADR-049)', async () => {
    const ONE_OFF_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1001';
    const oneOff = booking(ORGANIZATION_ID, event(20));
    await useCases.registerContract.execute({
      ...oneOff,
      payload: {
        ...oneOff.payload,
        missionId: ONE_OFF_ID,
        total: { amount: 90_000, currency: 'XOF' },
        plannedInterventions: 1,
        recurrence: null,
        // 20 novembre, 09:00 heure du Bénin : un mois de durée aurait coupé la prestation en deux.
        startsAt: '2026-11-20T08:00:00.000Z',
      },
    });
    world.clock.current = new Date('2027-01-05T00:00:00Z');
    await useCases.issueDueInvoices.execute();
    const invoices = [...world.invoices.invoices.values()].filter((i) => i.contractId === ONE_OFF_ID);
    expect(invoices.map((i) => [i.periodIndex, i.total, i.periodStart.toISOString()])).toEqual([
      [1, 90_000, '2026-11-19T23:00:00.000Z'],
    ]);
    expect(invoices[0]!.issuedAt).toEqual(new Date('2027-01-05T00:00:00Z'));
    expect(await useCases.issueDueInvoices.execute()).toEqual({ issued: 0, deferredContractIds: [] });
  });

  it('prestation ponctuelle annulée avant son jour : rien n’est facturé', async () => {
    const ONE_OFF_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1002';
    const oneOff = booking(ORGANIZATION_ID, event(21));
    await useCases.registerContract.execute({
      ...oneOff,
      payload: {
        ...oneOff.payload,
        missionId: ONE_OFF_ID,
        recurrence: null,
        startsAt: '2026-11-20T08:00:00.000Z',
      },
    });
    await useCases.terminateContract.execute({
      eventId: event(22),
      type: 'cleaning.request.cancelled',
      occurredAt: '2026-11-18T10:00:00Z',
      payload: {
        requestId: event(52),
        missionId: ONE_OFF_ID,
        customerId: CUSTOMER_ID,
        organizationId: ORGANIZATION_ID,
        cancelledBy: 'customer',
        outcome: 'cancelled',
      },
    });
    world.clock.current = new Date('2027-01-05T00:00:00Z');
    await useCases.issueDueInvoices.execute();
    expect([...world.invoices.invoices.values()].filter((i) => i.contractId === ONE_OFF_ID)).toEqual([]);
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

  it('client et back-office : appelés par la gateway seulement (ADR-049)', async () => {
    const mine = () => useCases.listMyInvoices.execute({ page: { limit: 20, cursor: null }, status: '' });
    const staff = () => useCases.getSettings.execute();
    const from = (callerService: string, fn: () => Promise<unknown>, roles = ['customer']) =>
      as(CUSTOMER_ID, fn, { callerService, roles, mfa: true, activeContext: ORGANIZATION_ID });
    expect(await code(from('payment', mine))).toBe('BILLING_CALLER_FORBIDDEN');
    expect(await code(from('wallet', staff, ['finance_officer']))).toBe('BILLING_CALLER_FORBIDDEN');
    expect(await code(from('gateway', mine))).toBe('ok');
    expect(await code(from('gateway', staff, ['finance_officer']))).toBe('ok');
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

describe('événements de cleaning arrivés avant la confirmation (ADR-032)', () => {
  let world: TestWorld;
  let useCases: ReturnType<typeof createUseCases>;

  beforeEach(() => {
    world = testWorld();
    useCases = createUseCases(world);
  });

  const cancellation = (
    organizationId: string | null | undefined,
    missionId: string | null = MISSION_ID,
  ) => ({
    eventId: event(5),
    type: 'cleaning.request.cancelled' as const,
    occurredAt: '2026-11-20T00:00:00Z',
    payload: {
      requestId: event(50),
      missionId,
      customerId: CUSTOMER_ID,
      cancelledBy: 'customer' as const,
      outcome: 'cancelled' as const,
      ...(organizationId === undefined ? {} : { organizationId }),
    },
  });
  const suspension = (organizationId: string | null) => ({
    eventId: event(3),
    type: 'cleaning.contract.suspended' as const,
    occurredAt: '2026-11-10T00:00:00Z',
    payload: {
      missionId: MISSION_ID,
      customerId: CUSTOMER_ID,
      organizationId,
      cause: 'unpaid_invoices' as const,
      unpaidCount: 2,
      threshold: 2,
      cancelledInterventionIds: [],
      releasedAgentIds: [],
      suspendedAt: '2026-11-10T00:00:00Z',
    },
  });
  const resumption = (organizationId: string | null) => ({
    eventId: event(4),
    type: 'cleaning.contract.resumed' as const,
    occurredAt: '2026-11-15T00:00:00Z',
    payload: {
      missionId: MISSION_ID,
      customerId: CUSTOMER_ID,
      organizationId,
      cause: 'unpaid_invoices' as const,
      unpaidCount: 1,
      resumedAt: '2026-11-15T00:00:00Z',
      rescheduledCount: 0,
      failedCount: 0,
    },
  });

  it('annulation avant la confirmation : erreur réessayable, non marquée traitée, appliquée ensuite', async () => {
    expect(await code(useCases.terminateContract.execute(cancellation(ORGANIZATION_ID)))).toBe(
      'BILLING_CONTRACT_NOT_YET_REGISTERED',
    );
    // L'événement n'est pas enregistré dans l'inbox : la file de reprise le représentera.
    expect(world.contracts.processed.size).toBe(0);
    await useCases.registerContract.execute(booking(ORGANIZATION_ID));
    await useCases.terminateContract.execute(cancellation(ORGANIZATION_ID));
    expect(world.contracts.contracts.get(MISSION_ID)?.terminatedAt).toEqual(new Date('2026-11-20T00:00:00Z'));
    // Le contrat annulé n'est plus facturé au-delà du jour de l'annulation.
    world.clock.current = new Date('2027-03-01T00:00:00Z');
    await useCases.issueDueInvoices.execute();
    expect([...world.invoices.invoices.values()].map((i) => i.periodIndex)).toEqual([1]);
  });

  it('suspension et reprise avant la confirmation : réessayées, puis appliquées', async () => {
    expect(await code(useCases.suspendContract.execute(suspension(ORGANIZATION_ID)))).toBe(
      'BILLING_CONTRACT_NOT_YET_REGISTERED',
    );
    expect(await code(useCases.resumeContract.execute(resumption(ORGANIZATION_ID)))).toBe(
      'BILLING_CONTRACT_NOT_YET_REGISTERED',
    );
    expect(world.contracts.processed.size).toBe(0);
    await useCases.registerContract.execute(booking(ORGANIZATION_ID));
    await useCases.resumeContract.execute(resumption(ORGANIZATION_ID));
    await useCases.suspendContract.execute(suspension(ORGANIZATION_ID));
    expect(world.contracts.contracts.get(MISSION_ID)).toMatchObject({
      suspendedSince: null,
      suspensions: [{ from: new Date('2026-11-10T00:00:00Z'), to: new Date('2026-11-15T00:00:00Z') }],
    });
  });

  it('particulier, demande sans mission, ou événement sans organisation (antérieur) : rien à attendre', async () => {
    await expect(useCases.terminateContract.execute(cancellation(null))).resolves.toBeUndefined();
    await expect(
      useCases.terminateContract.execute({ ...cancellation(ORGANIZATION_ID, null), eventId: event(6) }),
    ).resolves.toBeUndefined();
    await expect(
      useCases.terminateContract.execute({ ...cancellation(undefined), eventId: event(7) }),
    ).resolves.toBeUndefined();
    await expect(useCases.suspendContract.execute(suspension(null))).resolves.toBeUndefined();
    await expect(useCases.resumeContract.execute(resumption(null))).resolves.toBeUndefined();
    expect(world.contracts.contracts.size).toBe(0);
  });
});

describe('paiement en ligne d’une facture (ADR-031)', () => {
  let world: TestWorld;
  let useCases: ReturnType<typeof createUseCases>;
  const PAYMENT_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5001';

  beforeEach(async () => {
    world = testWorld();
    useCases = createUseCases(world);
    await useCases.registerContract.execute(booking(ORGANIZATION_ID));
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    await useCases.issueDueInvoices.execute();
  });

  const invoice = () => [...world.invoices.invoices.values()][0]!;
  const succeeded = (overrides: Partial<Parameters<typeof useCases.recordOnlinePayment.execute>[0]> = {}) =>
    useCases.recordOnlinePayment.execute({
      eventId: event(70),
      eventType: 'payment.intent.succeeded',
      paymentId: PAYMENT_ID,
      subjectType: 'billing_invoice',
      invoiceId: invoice().id,
      amount: 100_000,
      providerReference: 'trx_Ab12',
      succeededAt: '2026-12-05T10:00:00.000Z',
      ...overrides,
    });

  it('reste dû lu par payment seulement', async () => {
    const asService = (service: string) =>
      runWithContext({ correlationId: 'c-test', callerService: service }, () =>
        useCases.getInvoiceAmountDue.execute(invoice().id),
      );
    expect(await asService('payment')).toMatchObject({ paid: 0, balance: 100_000, onlinePaymentIds: [] });
    expect(await code(asService('gateway'))).toBe('BILLING_CALLER_FORBIDDEN');
    // Paiement en ligne enregistré : son identifiant est rendu à payment (ADR-032).
    await succeeded({ amount: 40_000 });
    expect(await asService('payment')).toMatchObject({
      paid: 40_000,
      balance: 60_000,
      onlinePaymentIds: [PAYMENT_ID],
    });
  });

  it('obligations (UC-ID-11) : une facture à payer bloque la suppression du compte ; identity seul', async () => {
    const asService = (service: string, userId = CUSTOMER_ID) =>
      runWithContext({ correlationId: 'c-test', callerService: service }, () =>
        useCases.hasPendingObligations.execute({ userId }),
      );
    expect(await asService('identity')).toEqual([
      {
        kind: 'unpaid_invoice',
        reference: invoice().number,
        description: `La facture ${invoice().number} (100 000 FCFA) est en attente de paiement.`,
      },
    ]);
    expect(await asService('identity', OTHER_CUSTOMER_ID)).toEqual([]);
    expect(await code(asService('gateway'))).toBe('BILLING_CALLER_FORBIDDEN');
    expect(await code(asService('identity', 'pas-un-uuid'))).toBe('BILLING_VALIDATION_FAILED');
    // Réglée : plus rien ne bloque.
    await succeeded();
    expect(await asService('identity')).toEqual([]);
  });

  it('payment.intent.succeeded : facture payée (billing.invoice.paid), idempotent', async () => {
    expect(await succeeded()).toEqual({ outcome: 'recorded', excess: 0 });
    expect((await succeeded()).outcome).toBe('duplicate');
    expect((await succeeded({ eventId: event(71) })).outcome).toBe('duplicate');
    expect(invoice()).toMatchObject({ status: 'paid', paidAt: new Date('2026-12-05T10:00:00.000Z') });
    expect(invoice().payments).toEqual([
      expect.objectContaining({ id: PAYMENT_ID, method: 'mobile_money_online', recordedBy: 'system' }),
    ]);
    expect(world.recorder.events.filter((e) => e.type === 'billing.invoice.paid')).toHaveLength(1);
  });

  it('facture déjà payée : paiement tardif enregistré, état et événements inchangés', async () => {
    await succeeded();
    const paid = world.recorder.events.length;
    // Facture déjà payée : tout le paiement tardif est en trop (signalé, à rembourser).
    expect(
      await succeeded({ eventId: event(72), paymentId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d5002' }),
    ).toEqual({ outcome: 'recorded', excess: 100_000 });
    expect(invoice().status).toBe('paid');
    expect(invoice().payments).toHaveLength(2);
    expect(world.recorder.events).toHaveLength(paid);
  });

  it('mission (cleaning) ou facture inconnue : ignoré', async () => {
    expect((await succeeded({ subjectType: 'cleaning_mission' })).outcome).toBe('ignored');
    expect((await succeeded({ invoiceId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9999' })).outcome).toBe('ignored');
  });

  it('au-delà du reste dû : excédent calculé', async () => {
    expect(await succeeded({ amount: 120_000 })).toEqual({ outcome: 'recorded', excess: 20_000 });
    expect(invoice().status).toBe('paid');
  });
});

describe('facture payée par le portefeuille prépayé (ADR-046)', () => {
  let world: TestWorld;
  let useCases: ReturnType<typeof createUseCases>;
  const KEY = 'wallet-pay-0001';

  beforeEach(async () => {
    world = testWorld();
    useCases = createUseCases(world);
    await useCases.registerContract.execute(booking(ORGANIZATION_ID));
    world.clock.current = new Date('2026-12-01T09:00:00Z');
    await useCases.issueDueInvoices.execute();
    world.wallet.balances.set(ORGANIZATION_ID, 150_000);
    world.recorder.events.length = 0;
  });

  const invoice = () => [...world.invoices.invoices.values()][0]!;
  const pay = (orgRole = 'org_member', key = KEY, activeContext = ORGANIZATION_ID) =>
    as(
      CUSTOMER_ID,
      () => useCases.payMyInvoiceFromWallet.execute({ invoiceId: invoice().id, idempotencyKey: key }),
      { activeContext, orgRole },
    );

  it('reste dû débité du portefeuille de l’organisation, facture payée ; même clé sans second débit', async () => {
    const paid = await pay();
    expect(paid).toMatchObject({ status: 'paid' });
    expect(invoice().payments).toEqual([
      expect.objectContaining({ amount: 100_000, method: 'wallet', recordedBy: CUSTOMER_ID }),
    ]);
    expect(invoice().payments[0]!.reference).toBe([...world.wallet.debits.values()][0]!.transactionId);
    expect([...world.wallet.debits.keys()]).toEqual([`${invoice().id}:${KEY}`]);
    expect(world.wallet.balances.get(ORGANIZATION_ID)).toBe(50_000);
    expect(world.recorder.events.map((e) => e.type)).toEqual(['billing.invoice.paid']);
    expect(await pay()).toMatchObject({ status: 'paid' });
    expect(invoice().payments).toHaveLength(1);
    expect(await code(pay('org_member', 'wallet-pay-0002'))).toBe('BILLING_INVALID_TRANSITION');
  });

  it('membre lecteur refusé ; facture hors périmètre introuvable ; portefeuille insuffisant', async () => {
    expect(await code(pay('org_viewer'))).toBe('AUTH_FORBIDDEN');
    expect(await code(pay('org_admin', KEY, 'personal'))).toBe('BILLING_INVOICE_NOT_FOUND');
    world.wallet.balances.set(ORGANIZATION_ID, 40_000);
    expect(await code(pay())).toBe('WALLET_INSUFFICIENT_FUNDS');
    expect(invoice().payments).toEqual([]);
  });

  it('réglée entre-temps : le débit est remboursé aussitôt', async () => {
    const debit = world.wallet.debit.bind(world.wallet);
    world.wallet.debit = async (input) => {
      const result = await debit(input);
      await asStaff(() =>
        useCases.recordInvoicePayment.execute({
          invoiceId: invoice().id,
          amount: 100_000,
          method: 'bank_transfer',
          reference: 'VIR-1',
        }),
      );
      return result;
    };
    expect(await code(pay())).toBe('BILLING_INVALID_TRANSITION');
    expect(world.wallet.refunds).toHaveLength(1);
  });

  it('débit du portefeuille enregistré ? true si un paiement de la facture le cite ; wallet seul (ADR-048)', async () => {
    const status = (transactionId: string, invoiceId = invoice().id, caller = 'wallet') =>
      runWithContext({ correlationId: 'c-test', callerService: caller }, () =>
        useCases.getWalletDebitStatus.execute({ invoiceId, transactionId }),
      );
    const unknown = '0192f1c4-0000-7000-d000-000000000999';
    expect(await status(unknown)).toBe(false);
    await pay();
    const debit = invoice().payments[0]!.reference!;
    expect(await status(debit)).toBe(true);
    expect(await status(debit, MISSION_ID)).toBe(false);
    expect(await code(status(debit, invoice().id, 'payment'))).toBe('BILLING_CALLER_FORBIDDEN');
  });
});
