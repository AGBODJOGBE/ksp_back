import { type NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  type IdentityServer,
  ORIGINS,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';
import { LINK_TOKEN, PAYOUT_ID, type PaymentServer, startPaymentStub } from './support/payment-stub';
import { HOLDER_ID, startWalletStub, type WalletServer } from './support/wallet-stub';

/**
 * Lien de paiement public (ADR-040), reversements de la finance (ADR-041) et portefeuille (ADR-042) :
 * ce que la gateway transmet, ce qu'elle refuse avant tout appel, et les droits du back-office.
 */
describe('gateway → liens de paiement, reversements, portefeuille', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let payment: PaymentServer;
  let wallet: WalletServer;
  let app: NestExpressApplication;
  let production: NestExpressApplication;
  let limited: NestExpressApplication;
  let customer: string;
  let finance: string;
  let cleaningAdmin: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    payment = await startPaymentStub(keys);
    wallet = await startWalletStub(keys);
    const urls = { identityUrl: identity.url, paymentUrl: payment.url, walletUrl: wallet.url, keys };
    app = await startGateway(urls);
    production = await startGateway({
      ...urls,
      env: {
        NODE_ENV: 'production',
        IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
        IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
        SERVICE_CLIENT_SECRET: 'secret',
        TRUST_PROXY: 'loopback',
      },
    });
    limited = await startGateway({ ...urls, env: { RATE_LIMIT_PAYMENT_LINK_PAY_PER_MINUTE: '1' } });
    customer = await keys.accessToken();
    const staff = (role: string) =>
      keys.accessToken({
        claims: { client_id: 'backoffice', mfa: true, roles: [{ role, scopeType: 'global' }] },
      });
    finance = await staff('finance_officer');
    cleaningAdmin = await staff('cleaning_admin');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await production?.close();
    await limited?.close();
    await identity?.close();
    await payment?.close();
    await wallet?.close();
  });

  beforeEach(() => {
    payment.stub.reset();
    wallet.stub.reset();
  });

  const http = (server = app) => request(server.getHttpServer());
  const backoffice = (req: request.Test, token: string) =>
    req.set('Origin', ORIGINS.backoffice).set('Authorization', `Bearer ${token}`);

  describe('lien de paiement public', () => {
    it('sans compte : résumé lu par son jeton, sans utilisateur transmis', async () => {
      const res = await http().get(`/api/v1/payment/links/${LINK_TOKEN}`).set('Origin', ORIGINS.web);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'active', amount: { amount: 25000, currency: 'XOF' } });
      expect(JSON.stringify(res.body)).not.toMatch(/payer|phone|customerId/i);
      const call = payment.stub.last('getPublicPaymentLink')!;
      expect(call.request).toEqual({ token: LINK_TOKEN });
      expect(call.context?.user).toBeUndefined();
    });

    it('jeton mal formé : 404 sans appel de payment', async () => {
      const res = await http().get('/api/v1/payment/links/court');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAYMENT_LINK_NOT_FOUND');
      expect(payment.stub.calls).toHaveLength(0);
    });

    it('paiement : clé d’idempotence obligatoire et transmise ; limite par adresse IP', async () => {
      expect((await http().post(`/api/v1/payment/links/${LINK_TOKEN}/pay`)).status).toBe(400);
      const res = await http()
        .post(`/api/v1/payment/links/${LINK_TOKEN}/pay`)
        .set('Idempotency-Key', 'cle-lien-0001');
      expect(res.status).toBe(200);
      expect(payment.stub.last('payPaymentLink')!.request).toEqual({
        token: LINK_TOKEN,
        idempotencyKey: 'cle-lien-0001',
      });
      const pay = () =>
        http(limited).post(`/api/v1/payment/links/${LINK_TOKEN}/pay`).set('Idempotency-Key', 'cle-lien-0002');
      expect((await pay()).status).toBe(200);
      expect((await pay()).status).toBe(429);
    });

    it('simulation fermée en production', async () => {
      const res = await http(production)
        .post(`/api/v1/payment/links/${LINK_TOKEN}/simulate`)
        .send({ outcome: 'succeeded' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PAYMENT_SIMULATION_DISABLED');
      expect(payment.stub.calls).toHaveLength(0);
    });
  });

  describe('reversements (finance)', () => {
    it('confirmation : référence et clé facultative transmises', async () => {
      const res = await backoffice(http().post(`/api/v1/admin/payment/payouts/${PAYOUT_ID}/confirm`), finance)
        .set('Idempotency-Key', 'cle-confirm-0001')
        .send({ transferReference: 'MTN-TRF-0042' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(payment.stub.last('confirmPayout')!.request).toEqual({
        payoutId: PAYOUT_ID,
        transferReference: 'MTN-TRF-0042',
        idempotencyKey: 'cle-confirm-0001',
      });
    });

    it('réservé à la finance (cleaning_admin refusé)', async () => {
      const res = await backoffice(http().get('/api/v1/admin/payment/payouts'), cleaningAdmin);
      expect(res.status).toBe(403);
      expect(payment.stub.calls).toHaveLength(0);
    });
  });

  describe('portefeuille', () => {
    it('titulaire connecté : utilisateur transmis dans le contexte', async () => {
      const res = await http()
        .get('/api/v1/wallet/me')
        .set('Origin', ORIGINS.web)
        .set('Authorization', `Bearer ${customer}`);
      expect(res.status).toBe(200);
      expect(res.body.balance).toEqual({ amount: 8750, currency: 'XOF' });
      expect(wallet.stub.last('getMyWallet')!.context?.user?.userId).toBe(USER_ID);
    });

    it('relevé : brut et commission pour un encaissement, null pour un reversement', async () => {
      const res = await http()
        .get('/api/v1/wallet/me/statement?limit=2')
        .set('Origin', ORIGINS.web)
        .set('Authorization', `Bearer ${customer}`);
      expect(res.body.data[0]).toMatchObject({
        kind: 'payout',
        grossAmount: null,
        payoutStatus: 'submitted',
      });
      expect(res.body.data[1]).toMatchObject({
        kind: 'collection',
        grossAmount: { amount: 25000, currency: 'XOF' },
        commissionRateBps: 1250,
      });
      expect(wallet.stub.last('listMyStatement')!.request).toEqual({
        page: { limit: 2, cursor: '' },
        account: '',
      });
    });

    it('back-office : titulaire validé avant l’appel ; réservé à la finance', async () => {
      const ok = await backoffice(
        http().get(`/api/v1/admin/wallet/holders/organization/${HOLDER_ID}`),
        finance,
      );
      expect(ok.status).toBe(200);
      expect(wallet.stub.last('getHolderWallet')!.request).toEqual({
        holder: { type: 'organization', id: HOLDER_ID },
      });
      const bad = await backoffice(http().get(`/api/v1/admin/wallet/holders/creditor/${HOLDER_ID}`), finance);
      expect(bad.status).toBe(400);
      const denied = await backoffice(http().get('/api/v1/admin/wallet/overview'), cleaningAdmin);
      expect(denied.status).toBe(403);
    });
    it('portefeuille prépayé (ADR-046) : solde, limites de recharge, relevé filtré', async () => {
      const auth = (req: request.Test) =>
        req.set('Origin', ORIGINS.web).set('Authorization', `Bearer ${customer}`);
      const mine = await auth(http().get('/api/v1/wallet/me'));
      expect(mine.body).toMatchObject({
        prepaid: { balance: { amount: 5000, currency: 'XOF' } },
        topUpLimits: { min: { amount: 500 }, max: { amount: 1000000 } },
      });
      const prepaid = await auth(http().get('/api/v1/wallet/me/statement?account=prepaid'));
      expect(prepaid.status).toBe(200);
      expect(wallet.stub.last('listMyStatement')!.request).toMatchObject({ account: 'prepaid' });
      const bad = await auth(http().get('/api/v1/wallet/me/statement?account=bonus'));
      expect(bad.status).toBe(400);
    });

    it('recharge : clé et montant vérifiés avant l’appel, transmis à wallet', async () => {
      const post = () =>
        http()
          .post('/api/v1/wallet/me/top-ups')
          .set('Origin', ORIGINS.web)
          .set('Authorization', `Bearer ${customer}`);
      expect((await post().send({ amount: { amount: 20000, currency: 'XOF' } })).status).toBe(400);
      const decimal = await post()
        .set('Idempotency-Key', 'recharge-0001')
        .send({ amount: { amount: 200.5, currency: 'XOF' } });
      expect(decimal.status).toBe(400);
      expect(wallet.stub.calls).toEqual([]);
      const ok = await post()
        .set('Idempotency-Key', 'recharge-0001')
        .send({ amount: { amount: 20000, currency: 'XOF' } });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: 'pending', checkoutUrl: expect.stringContaining('https://') });
      expect(wallet.stub.last('createTopUp')!.request).toEqual({
        idempotencyKey: 'recharge-0001',
        amount: { amount: 20000, currency: 'XOF' },
      });
    });

    it('crédit manuel : réservé à la finance, motif et clé transmis', async () => {
      const body = { kind: 'refund', amount: { amount: 5000, currency: 'XOF' }, reason: 'Passage manqué' };
      const url = `/api/v1/admin/wallet/holders/organization/${HOLDER_ID}/credits`;
      const denied = await backoffice(http().post(url), cleaningAdmin)
        .set('Idempotency-Key', 'credit-0001')
        .send(body);
      expect(denied.status).toBe(403);
      const ok = await backoffice(http().post(url), finance).set('Idempotency-Key', 'credit-0001').send(body);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        kind: 'refund',
        created: true,
        wallet: { balance: { amount: 10000 } },
      });
      expect(wallet.stub.last('creditPrepaidWallet')!.request).toEqual({
        idempotencyKey: 'credit-0001',
        holder: { type: 'organization', id: HOLDER_ID },
        kind: 'refund',
        amount: { amount: 5000, currency: 'XOF' },
        reason: 'Passage manqué',
        paymentId: '',
      });
    });
  });
});
