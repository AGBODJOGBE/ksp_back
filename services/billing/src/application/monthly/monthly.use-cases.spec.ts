import { type CleaningEventPayloads } from '@ksp/contracts';
import { createUseCases } from '../use-cases';
import { as, asCustomer, asStaff, CUSTOMER_ID, ORGANIZATION_ID, STAFF_ID } from '../testing/fakes';
import { type MonthlyTestWorld, monthlyTestWorld } from '../testing/monthly-fakes';
import { createMonthlyUseCases } from './use-cases';

const at = (iso: string) => new Date(iso);
const OTHER_ORG = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d0002';
const PROGRAM_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d2000';
const PLACE_ID = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d3000';
const xof = (amount: number) => ({ amount, currency: 'XOF' as const });
let sessionCounter = 0;
const nextSessionId = () => `0192f1c4-7a2b-7c3d-8e4f-${String(4000 + ++sessionCounter).padStart(12, '0')}`;

function completed(
  overrides: Partial<CleaningEventPayloads['cleaning.session.completed']> = {},
): CleaningEventPayloads['cleaning.session.completed'] {
  return {
    sessionId: nextSessionId(),
    programId: PROGRAM_ID,
    customerId: CUSTOMER_ID,
    organizationId: ORGANIZATION_ID,
    payerKind: 'organization',
    placeId: PLACE_ID,
    programNumber: 'PN-000057',
    rank: 1,
    sessionsCount: 12,
    scheduledStart: '2026-11-12T08:00:00Z',
    price: xof(25_000),
    visitFeeDeduction: xof(0),
    amountDue: xof(25_000),
    completedAt: '2026-11-12T10:00:00Z',
    completedBy: 'team',
    ...overrides,
  };
}

describe('Facture mensuelle des organisations (lot F)', () => {
  let world: MonthlyTestWorld;
  let monthly: ReturnType<typeof createMonthlyUseCases>;
  let billing: ReturnType<typeof createUseCases>;
  let eventCounter = 0;
  const eventId = () => `0192f1c4-7a2b-7c3d-8e4f-${String(9000 + ++eventCounter).padStart(12, '0')}`;
  const record = (payload = completed()) =>
    monthly.recordBillableSession.execute({
      eventId: eventId(),
      type: 'cleaning.session.completed',
      payload,
    });
  const invoices = () => [...world.invoices.invoices.values()].filter((i) => i.kind === 'monthly');

  beforeEach(() => {
    world = monthlyTestWorld();
    monthly = createMonthlyUseCases(world);
    billing = createUseCases(world);
    world.clock.current = at('2026-11-30T23:00:00Z'); // 1er décembre 00:00 au Bénin
  });

  describe('séances facturables (15.5 : le montant voyage dans l’événement)', () => {
    it('une séance d’organisation est gardée ; celle d’un particulier est ignorée ; doublon sans effet', async () => {
      const payload = completed();
      expect(await record(payload)).toBe('recorded');
      expect(await record(payload)).toBe('duplicate');
      expect(await record(completed({ payerKind: 'individual', organizationId: null }))).toBe('ignored');
      expect(world.monthly.sessions.size).toBe(1);
    });

    it('séance manquée : mois de l’absence constatée, annulation tardive distinguée', async () => {
      const missed: CleaningEventPayloads['cleaning.session.missed'] = {
        ...completed(),
        cause: 'late_cancellation',
        feeBps: 5000,
        amountDue: xof(12_500),
        missedAt: '2026-11-20T09:00:00Z',
        communeKey: 'cotonou',
        reportedBy: 'ksp',
      };
      delete (missed as Partial<typeof missed> & { completedAt?: string }).completedAt;
      delete (missed as Partial<typeof missed> & { completedBy?: string }).completedBy;
      await monthly.recordBillableSession.execute({
        eventId: eventId(),
        type: 'cleaning.session.missed',
        payload: missed,
      });
      expect([...world.monthly.sessions.values()][0]).toMatchObject({
        kind: 'late_cancellation',
        amountDue: 12_500,
        occurredAt: at('2026-11-20T09:00:00Z'),
      });
    });
  });

  describe('émission du 1er (R-PE-01, R-PE-02, R-PE-03)', () => {
    it('une facture par organisation pour le mois écoulé, en-tête figé, échéance à 10 jours, événement v2', async () => {
      await record(completed({ rank: 1, completedAt: '2026-11-05T10:00:00Z' }));
      await record(
        completed({
          rank: 2,
          completedAt: '2026-11-12T10:00:00Z',
          visitFeeDeduction: xof(5_000),
          amountDue: xof(20_000),
        }),
      );
      await record(completed({ rank: 3, completedAt: '2026-12-01T09:00:00Z' })); // décembre : attend

      expect(await monthly.issueMonthlyInvoices.execute()).toEqual({
        issued: 1,
        deferredOrganizationIds: [],
      });
      const [invoice] = invoices();
      expect(invoice).toMatchObject({
        number: 'FAC-2026-000001',
        status: 'pending_payment',
        total: 45_000,
        contractId: null,
        organization: { legalName: 'SARL Bénin Propre', ifu: '3201912345678' },
        dueAt: at('2026-12-10T23:00:00Z'),
      });
      expect(invoice!.lines.map((line) => line.amount)).toEqual([25_000, 25_000, -5_000]);
      expect(world.recorder.events).toEqual([
        expect.objectContaining({
          type: 'billing.invoice.issued',
          version: 2,
          payload: expect.objectContaining({
            kind: 'monthly',
            status: 'pending_payment',
            total: xof(45_000),
          }),
        }),
      ]);
      expect(world.recorder.events[0]!.payload).not.toHaveProperty('contractId');

      expect(await monthly.issueMonthlyInvoices.execute()).toEqual({
        issued: 0,
        deferredOrganizationIds: [],
      });
    });

    it('une séance de novembre arrivée après l’émission part sur la facture de décembre (R-PE-07)', async () => {
      await record(completed({ completedAt: '2026-11-05T10:00:00Z' }));
      await monthly.issueMonthlyInvoices.execute();
      await record(completed({ rank: 2, completedAt: '2026-11-29T10:00:00Z' }));
      expect(await monthly.issueMonthlyInvoices.execute()).toEqual({
        issued: 0,
        deferredOrganizationIds: [],
      });
      world.clock.current = at('2026-12-31T23:00:00Z'); // 1er janvier 2027
      await record(completed({ rank: 3, completedAt: '2026-12-10T10:00:00Z' }));
      await monthly.issueMonthlyInvoices.execute();
      const december = invoices().find(
        (i) => i.periodStart.getTime() === at('2026-11-30T23:00:00Z').getTime(),
      );
      expect(december).toMatchObject({ number: 'FAC-2026-000002', total: 50_000 });
    });

    it('jamais sans en-tête : identity indisponible → rien ; organisation introuvable → reportée', async () => {
      await record();
      await record(completed({ organizationId: OTHER_ORG }));
      world.organizations.unavailable = true;
      await expect(monthly.issueMonthlyInvoices.execute()).rejects.toThrow('identity indisponible');
      expect(invoices()).toHaveLength(0);
      world.organizations.unavailable = false;
      expect(await monthly.issueMonthlyInvoices.execute()).toEqual({
        issued: 1,
        deferredOrganizationIds: [OTHER_ORG],
      });
    });

    it('rien à facturer : aucune lecture d’identity', async () => {
      expect(await monthly.issueMonthlyInvoices.execute()).toEqual({
        issued: 0,
        deferredOrganizationIds: [],
      });
      expect(world.organizations.lookups).toHaveLength(0);
    });
  });

  describe('échéance, impayé, relances (R-PE-05, R-PE-06)', () => {
    beforeEach(async () => {
      await record();
      await monthly.issueMonthlyInvoices.execute();
      world.recorder.events.length = 0;
    });

    it('impayée le lendemain de l’échéance, avec le compte des impayées de l’organisation', async () => {
      world.clock.current = at('2026-12-11T22:00:00Z');
      expect(await monthly.markMonthlyInvoicesOverdue.execute()).toEqual({ overdue: 0 });
      world.clock.current = at('2026-12-11T23:00:00Z');
      expect(await monthly.markMonthlyInvoicesOverdue.execute()).toEqual({ overdue: 1 });
      expect(world.recorder.events).toEqual([
        expect.objectContaining({
          type: 'billing.invoice.overdue',
          version: 2,
          payload: expect.objectContaining({ holderOverdueCount: 1, overdueCount: 1, kind: 'monthly' }),
        }),
      ]);
      expect(await monthly.countOrganizationUnpaidInvoices.execute(ORGANIZATION_ID)).toBe(1);
      // La tâche v1 ne touche pas une facture v2.
      expect(await billing.markOverdueInvoices.execute()).toEqual({ overdue: 0 });
    });

    it('relances −3, 0, +3, +7 jours, une seule fois chacune', async () => {
      world.clock.current = at('2026-12-07T23:00:00Z');
      expect(await monthly.sendInvoiceReminders.execute()).toEqual({ reminded: 1 });
      expect(await monthly.sendInvoiceReminders.execute()).toEqual({ reminded: 0 });
      world.clock.current = at('2026-12-18T00:00:00Z'); // +7 : 0 et +3 sautées
      expect(await monthly.sendInvoiceReminders.execute()).toEqual({ reminded: 1 });
      const offsets = world.recorder.events
        .filter((event) => event.type === 'billing.invoice.reminded')
        .map((event) => (event.payload as { offsetDays: number }).offsetDays);
      expect(offsets).toEqual([-3, 7]);
      expect(await monthly.sendInvoiceReminders.execute()).toEqual({ reminded: 0 });
    });
  });

  describe('règlement (R-PE-04, RV-87)', () => {
    beforeEach(async () => {
      await record();
      await monthly.issueMonthlyInvoices.execute();
      world.recorder.events.length = 0;
    });

    it('payée depuis le portefeuille de l’organisation : billing.invoice.paid v2, settledBy payment', async () => {
      const [invoice] = invoices();
      world.wallet.balances.set(ORGANIZATION_ID, 30_000);
      const paid = await as(
        CUSTOMER_ID,
        () =>
          billing.payMyInvoiceFromWallet.execute({ invoiceId: invoice!.id, idempotencyKey: 'paiement-0001' }),
        { activeContext: ORGANIZATION_ID, orgRole: 'org_admin' },
      );
      expect(paid).toMatchObject({ status: 'paid', settledBy: 'payment' });
      expect(world.recorder.events).toEqual([
        expect.objectContaining({
          type: 'billing.invoice.paid',
          version: 2,
          payload: expect.objectContaining({ settledBy: 'payment', holderOverdueCount: 0 }),
        }),
      ]);
    });

    it('paiement hors ligne refusé sur une facture v2 (un seul chemin pour l’argent)', async () => {
      const [invoice] = invoices();
      await expect(
        asStaff(() =>
          billing.recordInvoicePayment.execute({
            invoiceId: invoice!.id,
            amount: 25_000,
            method: 'cash',
            reference: '',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'BILLING_PAYMENT_INVALID',
        details: { reason: 'wallet_path_required' },
      });
    });

    it('virement crédité au portefeuille pour la facture : débité aussitôt (wallet.prepaid.credited v2)', async () => {
      const [invoice] = invoices();
      world.wallet.balances.set(ORGANIZATION_ID, 25_000);
      const credit = {
        transactionId: '0192f1c4-0000-7000-e000-000000000001',
        kind: 'top_up' as const,
        topUpChannel: 'bank_transfer' as const,
        forObject: { service: 'billing', objectType: 'billing_invoice', objectId: invoice!.id, part: null },
        origin: 'finance' as const,
        holder: { type: 'organization' as const, id: ORGANIZATION_ID },
        userId: null,
        amount: xof(25_000),
        balanceAfter: xof(25_000),
        description: 'Virement',
        paymentId: null,
        refundedTransactionId: null,
        creditedAt: '2026-12-05T10:00:00Z',
      };
      expect(await monthly.settleInvoiceFromWalletCredit.execute({ payload: credit })).toBe('paid');
      expect(await monthly.settleInvoiceFromWalletCredit.execute({ payload: credit })).toBe('duplicate');
      expect(
        await monthly.settleInvoiceFromWalletCredit.execute({
          payload: { ...credit, transactionId: '0192f1c4-0000-7000-e000-000000000002' },
        }),
      ).toBe('left_in_wallet');
      expect(
        await monthly.settleInvoiceFromWalletCredit.execute({ payload: { ...credit, forObject: undefined } }),
      ).toBe('ignored');
      expect(
        await monthly.settleInvoiceFromWalletCredit.execute({
          payload: { ...credit, holder: { type: 'organization', id: OTHER_ORG } },
        }),
      ).toBe('ignored');
    });

    it('crédit partiel, ou solde dépensé entre-temps', async () => {
      const [invoice] = invoices();
      const credit = {
        transactionId: '0192f1c4-0000-7000-e000-000000000003',
        kind: 'top_up' as const,
        forObject: { service: 'billing', objectType: 'billing_invoice', objectId: invoice!.id, part: null },
        origin: 'finance' as const,
        holder: { type: 'organization' as const, id: ORGANIZATION_ID },
        userId: null,
        amount: xof(10_000),
        balanceAfter: xof(10_000),
        description: 'Virement',
        paymentId: null,
        refundedTransactionId: null,
        creditedAt: '2026-12-05T10:00:00Z',
      };
      expect(await monthly.settleInvoiceFromWalletCredit.execute({ payload: credit })).toBe('left_in_wallet');
      world.wallet.balances.set(ORGANIZATION_ID, 10_000);
      expect(await monthly.settleInvoiceFromWalletCredit.execute({ payload: credit })).toBe('partially_paid');
    });
  });

  describe('avoirs (R-PE-07) et annulation', () => {
    const line = (amount: number) => ({
      label: 'Séance non conforme',
      quantity: 1,
      unitPrice: amount,
      amount,
    });
    beforeEach(async () => {
      await record();
      await monthly.issueMonthlyInvoices.execute();
      world.recorder.events.length = 0;
    });

    it('avoir de cleaning imputé sur le reste dû ; rejeu de la même clé ; clé réutilisée refusée', async () => {
      const [invoice] = invoices();
      const request = {
        idempotencyKey: 'cleaning_claim_credit_note:1',
        invoiceId: invoice!.id,
        lines: [line(5_000)],
        reason: 'Réclamation',
      };
      const first = await as('svc', () => monthly.issueCreditNote.execute(request), {
        callerService: 'cleaning',
      });
      expect(first).toMatchObject({
        created: true,
        creditNote: { number: 'AV-2026-000001', appliedToBalance: 5_000 },
      });
      expect(world.recorder.events.map((e) => e.type)).toEqual(['billing.credit_note.issued']);
      const again = await monthly.issueCreditNote.execute(request);
      expect(again.created).toBe(false);
      await record(completed({ organizationId: OTHER_ORG }));
      world.organizations.profiles.set(OTHER_ORG, {
        ...world.organizations.profiles.get(ORGANIZATION_ID)!,
        id: OTHER_ORG,
      });
      await monthly.issueMonthlyInvoices.execute();
      const other = invoices().find((i) => i.organizationId === OTHER_ORG)!;
      await expect(
        monthly.issueCreditNote.execute({ ...request, invoiceId: other.id }),
      ).rejects.toMatchObject({
        code: 'BILLING_IDEMPOTENCY_KEY_REUSED',
      });
      await expect(
        as('svc', () => monthly.issueCreditNote.execute(request), { callerService: 'payment' }),
      ).rejects.toMatchObject({ code: 'BILLING_CALLER_FORBIDDEN' });
    });

    it('avoir qui solde la facture : billing.invoice.paid v2, settledBy credit_note ; au-delà du total refusé', async () => {
      const [invoice] = invoices();
      await expect(
        monthly.issueCreditNote.execute({
          idempotencyKey: 'avoir-trop-grand',
          invoiceId: invoice!.id,
          lines: [line(25_001)],
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'BILLING_CREDIT_NOTE_EXCEEDS_INVOICE', details: { maximum: 25_000 } });
      const result = await monthly.issueCreditNote.execute({
        idempotencyKey: 'avoir-total-1',
        invoiceId: invoice!.id,
        lines: [line(25_000)],
        reason: 'Séance annulée par KSP',
      });
      expect(result.invoice).toMatchObject({ status: 'paid', settledBy: 'credit_note' });
      expect(world.recorder.events[1]).toMatchObject({
        type: 'billing.invoice.paid',
        version: 2,
        payload: { settledBy: 'credit_note', holderOverdueCount: 0 },
      });
      await expect(
        monthly.issueCreditNote.execute({
          idempotencyKey: 'avoir-total-2',
          invoiceId: invoice!.id,
          lines: [line(1)],
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'BILLING_CREDIT_NOTE_EXCEEDS_INVOICE', details: { maximum: 0 } });
    });

    it('facture payée : la part de l’avoir va au portefeuille de l’organisation, une seule fois', async () => {
      const [invoice] = invoices();
      world.wallet.balances.set(ORGANIZATION_ID, 25_000);
      await as(
        CUSTOMER_ID,
        () =>
          billing.payMyInvoiceFromWallet.execute({ invoiceId: invoice!.id, idempotencyKey: 'paiement-0002' }),
        { activeContext: ORGANIZATION_ID, orgRole: 'org_member' },
      );
      const request = {
        idempotencyKey: 'avoir-apres-paiement',
        invoiceId: invoice!.id,
        lines: [line(4_000)],
        reason: 'Geste',
      };
      const result = await monthly.issueCreditNote.execute(request);
      expect(result.creditNote).toMatchObject({ appliedToBalance: 0, creditedToWallet: 4_000 });
      expect(result.creditNote.walletTransactionId).not.toBeNull();
      await monthly.issueCreditNote.execute(request);
      expect([...world.walletCredits.credits.values()]).toEqual([
        expect.objectContaining({ amount: 4_000, holderId: ORGANIZATION_ID }),
      ]);
    });

    it('validation : lignes et motif ; clé invalide ; facture inconnue', async () => {
      const [invoice] = invoices();
      await expect(
        monthly.issueCreditNote.execute({
          idempotencyKey: 'court',
          invoiceId: invoice!.id,
          lines: [line(1)],
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'BILLING_VALIDATION_FAILED', details: { field: 'idempotencyKey' } });
      await expect(
        monthly.issueCreditNote.execute({
          idempotencyKey: 'avoir-sans-motif',
          invoiceId: invoice!.id,
          lines: [line(1)],
          reason: ' ',
        }),
      ).rejects.toMatchObject({ details: { field: 'reason' } });
      await expect(
        monthly.issueCreditNote.execute({
          idempotencyKey: 'avoir-inconnu',
          invoiceId: '0192f1c4-7a2b-7c3d-8e4f-000000000999',
          lines: [line(1)],
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'BILLING_INVOICE_NOT_FOUND' });
    });

    it('avoir saisi par la finance : rôle et double authentification exigés', async () => {
      const [invoice] = invoices();
      const request = {
        idempotencyKey: 'avoir-finance-1',
        invoiceId: invoice!.id,
        lines: [line(1_000)],
        reason: 'Erreur',
      };
      const result = await asStaff(() => monthly.issueAdminCreditNote.execute(request));
      expect(result.creditNote.issuedBy).toBe(STAFF_ID);
      expect(await asStaff(() => monthly.listInvoiceCreditNotes.execute(invoice!.id))).toHaveLength(1);
      await expect(
        asStaff(() => monthly.issueAdminCreditNote.execute(request), 'cleaning_supervisor'),
      ).rejects.toMatchObject({
        code: 'AUTH_FORBIDDEN',
      });
      await expect(
        as(STAFF_ID, () => monthly.issueAdminCreditNote.execute(request), { roles: ['finance_officer'] }),
      ).rejects.toMatchObject({ code: 'AUTH_MFA_REQUIRED' });
    });

    it('annulation : sort des impayés (settledBy cancellation), séances refacturées si demandé', async () => {
      const [invoice] = invoices();
      world.clock.current = at('2026-12-12T00:00:00Z');
      await monthly.markMonthlyInvoicesOverdue.execute();
      world.recorder.events.length = 0;
      const cancelled = await asStaff(() =>
        monthly.cancelInvoice.execute({ invoiceId: invoice!.id, releaseSessions: true }),
      );
      expect(cancelled).toMatchObject({ status: 'cancelled', settledBy: 'cancellation' });
      expect(world.recorder.events).toEqual([
        expect.objectContaining({
          type: 'billing.invoice.paid',
          version: 2,
          payload: expect.objectContaining({ settledBy: 'cancellation', holderOverdueCount: 0 }),
        }),
      ]);
      expect([...world.monthly.sessions.values()].every((s) => s.invoiceId === null)).toBe(true);
      await expect(
        asStaff(() => monthly.cancelInvoice.execute({ invoiceId: invoice!.id, releaseSessions: false })),
      ).rejects.toMatchObject({ code: 'BILLING_INVALID_TRANSITION' });
    });

    it('annulation refusée après un paiement partiel', async () => {
      const [invoice] = invoices();
      world.invoices.invoices.set(invoice!.id, {
        ...invoice!,
        payments: [
          {
            id: 'p',
            amount: 1_000,
            method: 'wallet',
            reference: 't',
            recordedBy: CUSTOMER_ID,
            recordedAt: at('2026-12-02'),
          },
        ],
      });
      await expect(
        asStaff(() => monthly.cancelInvoice.execute({ invoiceId: invoice!.id, releaseSessions: false })),
      ).rejects.toMatchObject({ code: 'BILLING_PAYMENT_INVALID', details: { reason: 'partially_paid' } });
    });
  });

  it('« Mes factures » de l’organisation : la facture mensuelle y figure', async () => {
    await record();
    await monthly.issueMonthlyInvoices.execute();
    const page = await asCustomer(() =>
      billing.listMyInvoices.execute({ page: { limit: 20, cursor: null }, status: '' }),
    );
    expect(page.items.map((i) => i.kind)).toEqual(['monthly']);
  });
});
