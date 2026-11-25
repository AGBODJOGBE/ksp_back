import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  type BillingServer,
  COMMISSION_INVOICE_ID,
  INVOICE_ID,
  protoCommissionInvoice,
  protoInvoice,
  startBillingStub,
} from './support/billing-stub';
import {
  type IdentityServer,
  ORIGINS,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

/**
 * Ce que la gateway transmet à billing : utilisateur et rôles dans le
 * contexte, filtres, montants convertis en { amount, currency } ; refus avant tout appel quand
 * le rôle ou la double authentification manquent.
 */
describe('gateway → billing', () => {
  const CONTRACT = '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d1000';
  let keys: TestKeys;
  let identity: IdentityServer;
  let billing: BillingServer;
  let app: NestExpressApplication;
  let customer: string;
  let finance: string;
  let supervisorWithoutMfa: string;

  // Trois serveurs démarrés (identity, billing, gateway) : marge pour une machine chargée.
  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    billing = await startBillingStub(keys);
    app = await startGateway({ identityUrl: identity.url, billingUrl: billing.url, keys });
    customer = await keys.accessToken();
    const staff = (role: string, mfa: boolean) =>
      keys.accessToken({ claims: { client_id: 'backoffice', mfa, roles: [{ role, scopeType: 'global' }] } });
    finance = await staff('finance_officer', true);
    supervisorWithoutMfa = await staff('cleaning_supervisor', false);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await identity?.close();
    await billing?.close();
  });

  beforeEach(() => billing.stub.reset());

  const http = () => request(app.getHttpServer());
  const web = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.web).set('Authorization', `Bearer ${token}`);
  const backoffice = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.backoffice).set('Authorization', `Bearer ${token}`);

  it('« Mes factures » : filtre d’état transmis, montants en entiers XOF, null pour les vides', async () => {
    const res = await web(http().get('/api/v1/billing/invoices?status=overdue&limit=5'), customer);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      id: INVOICE_ID,
      status: 'overdue',
      total: { amount: 160000, currency: 'XOF' },
      balance: { amount: 100000, currency: 'XOF' },
      paidAt: null,
    });
    expect(res.body.data[0].payments[0].reference).toBeNull();
    expect(res.body.data[0].organization).toEqual({
      legalName: 'SARL Bénin Propre',
      address: 'Lot 12, Haie Vive, Cotonou',
      ifu: '3201912345678',
      rccm: null,
    });
    const call = billing.stub.last('listMyInvoices')!;
    expect(call.request).toMatchObject({ status: 'overdue', page: { limit: 5, cursor: '' } });
    expect(call.context?.user?.userId).toBe(USER_ID);
  });

  it('back-office : filtres et paiement manuel, montant converti en Money', async () => {
    const list = await backoffice(
      http().get(`/api/v1/admin/billing/invoices?contractId=${CONTRACT}`),
      finance,
    );
    expect(list.status).toBe(200);
    expect(list.body.nextCursor).toBe(INVOICE_ID);
    expect(billing.stub.last('listInvoices')!.request).toMatchObject({
      contractId: CONTRACT,
      customerId: '',
      periodFrom: '',
      periodTo: '',
    });

    // Période facturée : dates transmises telles quelles (billing les lit à l'heure du Bénin).
    const period = await backoffice(
      http().get('/api/v1/admin/billing/invoices?from=2026-11-01&to=2026-11-30'),
      finance,
    );
    expect(period.status).toBe(200);
    expect(billing.stub.last('listInvoices')!.request).toMatchObject({
      periodFrom: '2026-11-01',
      periodTo: '2026-11-30',
    });
    const badPeriod = await backoffice(http().get('/api/v1/admin/billing/invoices?from=01/11/2026'), finance);
    expect(badPeriod.status).toBe(400);

    const paid = await backoffice(
      http().post(`/api/v1/admin/billing/invoices/${INVOICE_ID}/payments`),
      finance,
    ).send({ amount: 100000, method: 'cash' });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'paid', balance: { amount: 0, currency: 'XOF' } });
    // Facture d'un particulier, ou émise avant l'en-tête : organisation absente → null.
    billing.stub.on('getInvoice', async () => ({ invoice: { ...protoInvoice, organization: undefined } }));
    const detail = await backoffice(http().get(`/api/v1/admin/billing/invoices/${INVOICE_ID}`), finance);
    expect(detail.status).toBe(200);
    expect(detail.body.organization).toBeNull();
    expect(billing.stub.last('recordInvoicePayment')!.request).toEqual({
      invoiceId: INVOICE_ID,
      amount: { amount: 100000, currency: 'XOF' },
      method: 'cash',
      reference: '',
      idempotencyKey: '',
    });

    // Idempotency-Key facultative : transmise si présente, refusée si mal formée.
    const keyed = await backoffice(
      http().post(`/api/v1/admin/billing/invoices/${INVOICE_ID}/payments`),
      finance,
    )
      .set('Idempotency-Key', 'paiement-cle-0001')
      .send({ amount: 100000, method: 'cash' });
    expect(keyed.status).toBe(200);
    expect(billing.stub.last('recordInvoicePayment')!.request).toMatchObject({
      idempotencyKey: 'paiement-cle-0001',
    });
    const badKey = await backoffice(
      http().post(`/api/v1/admin/billing/invoices/${INVOICE_ID}/payments`),
      finance,
    )
      .set('Idempotency-Key', 'court')
      .send({ amount: 100000, method: 'cash' });
    expect(badKey.status).toBe(400);
  });

  it('refus avant tout appel : client sur le back-office, double authentification absente, corps invalide', async () => {
    expect((await backoffice(http().get('/api/v1/admin/billing/invoices'), customer)).status).toBe(403);
    const noMfa = await backoffice(http().get('/api/v1/admin/billing/invoices'), supervisorWithoutMfa);
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.error.code).toBe('GATEWAY_MFA_REQUIRED');
    const wrong = await backoffice(http().put('/api/v1/admin/billing/settings'), finance).send({
      paymentTermDays: 91,
    });
    expect(wrong.status).toBe(400);
    expect(billing.stub.calls).toEqual([]);
  });

  describe('recouvrement (ADR-064) : factures de commission et reçus des frais', () => {
    const staffToken = (role: string, mfa = true) =>
      keys.accessToken({ claims: { client_id: 'backoffice', mfa, roles: [{ role, scopeType: 'global' }] } });

    it('« Mes factures de commission » : filtres transmis, hors taxe, null pour les vides', async () => {
      const res = await web(
        http().get('/api/v1/billing/commission-invoices?status=pending_payment&period=2026-11&limit=5'),
        customer,
      );
      expect(res.status).toBe(200);
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.data[0]).toMatchObject({
        id: COMMISSION_INVOICE_ID,
        number: 'FCR-2026-000007',
        creditor: { type: 'organization' },
        period: '2026-11',
        commissionInvoiced: { amount: 9000, currency: 'XOF' },
        balance: { amount: 9000, currency: 'XOF' },
        amountsExcludingTax: true,
        paidAt: null,
        walletTransactionId: null,
        debit: { attempts: 1, lastFailure: 'insufficient_funds', missing: { amount: 5000, currency: 'XOF' } },
      });
      expect(res.body.data[0].organization.rccm).toBeNull();
      expect(res.body.data[0].lines[0]).toMatchObject({ receivedOn: '2026-11-04', settlement: 'invoiced' });
      const call = billing.stub.last('listMyCommissionInvoices')!;
      expect(call.request).toMatchObject({
        status: 'pending_payment',
        period: '2026-11',
        page: { limit: 5 },
      });
      expect(call.context?.user?.userId).toBe(USER_ID);

      // Rien à débiter, compte créancier : débit et en-tête absents → null.
      billing.stub.on('getMyCommissionInvoice', async () => ({
        commissionInvoice: { ...protoCommissionInvoice, debit: undefined, organization: undefined },
      }));
      const detail = await web(
        http().get(`/api/v1/billing/commission-invoices/${COMMISSION_INVOICE_ID}`),
        customer,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ debit: null, organization: null });
      expect(billing.stub.last('getMyCommissionInvoice')!.request).toEqual({
        invoiceId: COMMISSION_INVOICE_ID,
      });

      const receipts = await web(http().get(`/api/v1/billing/receipts?caseId=${CONTRACT}`), customer);
      expect(receipts.status).toBe(200);
      expect(receipts.body.data[0]).toMatchObject({
        number: 'RFD-2026-000012',
        kind: 'case_fee',
        caseNumber: 'RC-000123',
      });
      expect(billing.stub.last('listMyFeeReceipts')!.request).toMatchObject({ caseId: CONTRACT });
    });

    it('refus avant tout appel : mois, état ou dossier mal formés', async () => {
      for (const url of [
        '/api/v1/billing/commission-invoices?period=2026-13',
        '/api/v1/billing/commission-invoices?period=11/2026',
        '/api/v1/billing/commission-invoices?status=overdue',
        '/api/v1/billing/receipts?caseId=RC-000123',
      ]) {
        expect((await web(http().get(url), customer)).status).toBe(400);
      }
      expect(billing.stub.calls).toEqual([]);
    });

    it('back-office : finance, super administrateur, administration du recouvrement ; autres rôles refusés', async () => {
      const recoveryAdmin = await staffToken('recovery_admin');
      const list = await backoffice(
        http().get(`/api/v1/admin/billing/commission-invoices?creditorId=${USER_ID}&period=2026-11`),
        recoveryAdmin,
      );
      expect(list.status).toBe(200);
      expect(list.body.nextCursor).toBe(COMMISSION_INVOICE_ID);
      expect(billing.stub.last('listCommissionInvoices')!.request).toMatchObject({
        creditorId: USER_ID,
        period: '2026-11',
        status: '',
      });
      const detail = await backoffice(
        http().get(`/api/v1/admin/billing/commission-invoices/${COMMISSION_INVOICE_ID}`),
        finance,
      );
      expect(detail.status).toBe(200);
      expect(detail.body.number).toBe('FCR-2026-000007');
      expect(
        (
          await backoffice(
            http().get('/api/v1/admin/billing/commission-invoices'),
            await staffToken('super_admin'),
          )
        ).status,
      ).toBe(200);

      billing.stub.reset();
      // Lecture des factures du Nettoyage sans les factures de commission.
      const supervisor = await staffToken('cleaning_supervisor');
      expect(
        (await backoffice(http().get('/api/v1/admin/billing/commission-invoices'), supervisor)).status,
      ).toBe(403);
      const noMfa = await backoffice(
        http().get(`/api/v1/admin/billing/commission-invoices/${COMMISSION_INVOICE_ID}`),
        await staffToken('recovery_admin', false),
      );
      expect(noMfa.status).toBe(403);
      expect(noMfa.body.error.code).toBe('GATEWAY_MFA_REQUIRED');
      expect(
        (await backoffice(http().get('/api/v1/admin/billing/commission-invoices'), customer)).status,
      ).toBe(403);
      expect(billing.stub.calls).toEqual([]);
    });
  });
});
