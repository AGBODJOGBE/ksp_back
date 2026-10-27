import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { type BillingServer, INVOICE_ID, startBillingStub } from './support/billing-stub';
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
    });

    const paid = await backoffice(
      http().post(`/api/v1/admin/billing/invoices/${INVOICE_ID}/payments`),
      finance,
    ).send({ amount: 100000, method: 'cash' });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: 'paid', balance: { amount: 0, currency: 'XOF' } });
    expect(billing.stub.last('recordInvoicePayment')!.request).toEqual({
      invoiceId: INVOICE_ID,
      amount: { amount: 100000, currency: 'XOF' },
      method: 'cash',
      reference: '',
    });
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
});
