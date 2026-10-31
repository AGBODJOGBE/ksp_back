import { AppError } from '@ksp/platform';
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
import { MISSION_ID, PAYMENT_ID, type PaymentServer, startPaymentStub } from './support/payment-stub';

/**
 * Ce que la gateway transmet à payment (ADR-031) : utilisateur dans le contexte, clé d'idempotence,
 * jamais de montant ; notification du prestataire transmise octet pour octet avec sa signature ;
 * simulation fermée en production ; back-office réservé aux rôles avec double authentification.
 */
describe('gateway → payment', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let payment: PaymentServer;
  let app: NestExpressApplication;
  let production: NestExpressApplication;
  let limited: NestExpressApplication;
  let customer: string;
  let finance: string;
  let supervisor: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    payment = await startPaymentStub(keys);
    app = await startGateway({ identityUrl: identity.url, paymentUrl: payment.url, keys });
    production = await startGateway({
      identityUrl: identity.url,
      paymentUrl: payment.url,
      keys,
      env: {
        NODE_ENV: 'production',
        IDENTITY_JWKS_URL: 'http://identity:3101/.well-known/jwks.json',
        IDENTITY_TOKEN_URL: 'http://identity:3101/oauth/token',
        SERVICE_CLIENT_SECRET: 'secret',
        TRUST_PROXY: 'loopback',
      },
    });
    // Limites basses pour vérifier les catégories payment_create (par utilisateur) et payment_webhook (par IP).
    limited = await startGateway({
      identityUrl: identity.url,
      paymentUrl: payment.url,
      keys,
      env: { RATE_LIMIT_PAYMENT_CREATE_PER_MINUTE: '2', RATE_LIMIT_PAYMENT_WEBHOOK_PER_MINUTE: '2' },
    });
    customer = await keys.accessToken();
    const staff = (role: string) =>
      keys.accessToken({
        claims: { client_id: 'backoffice', mfa: true, roles: [{ role, scopeType: 'global' }] },
      });
    finance = await staff('finance_officer');
    supervisor = await staff('cleaning_supervisor');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await production?.close();
    await limited?.close();
    await identity?.close();
    await payment?.close();
  });

  beforeEach(() => payment.stub.reset());

  const http = (server = app) => request(server.getHttpServer());
  const web = (req: request.Test, token = customer) =>
    req.set('Origin', ORIGINS.web).set('Authorization', `Bearer ${token}`);

  it('création : objet et clé transmis, utilisateur dans le contexte, paiement au format du contrat', async () => {
    const res = await web(http().post('/api/v1/payment/payments'))
      .set('Idempotency-Key', 'pay-key-0001')
      .send({ subjectType: 'cleaning_mission', subjectId: MISSION_ID, part: 'deposit' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: PAYMENT_ID,
      status: 'pending',
      subject: { type: 'cleaning_mission', id: MISSION_ID, part: 'deposit', reference: null },
      amount: { amount: 15000, currency: 'XOF' },
      organizationId: null,
      checkoutUrl: 'https://process.fedapay.com/tok',
      completedAt: null,
    });
    const call = payment.stub.last('createPayment')!;
    expect(call.request).toEqual({
      subjectType: 'cleaning_mission',
      subjectId: MISSION_ID,
      part: 'deposit',
      idempotencyKey: 'pay-key-0001',
    });
    expect(call.context?.user?.userId).toBe(USER_ID);
  });

  it('création : montant refusé (jamais envoyé par le client), clé obligatoire', async () => {
    const withAmount = await web(http().post('/api/v1/payment/payments'))
      .set('Idempotency-Key', 'pay-key-0001')
      .send({ subjectType: 'billing_invoice', subjectId: MISSION_ID, amount: 10 });
    expect(withAmount.status).toBe(400);
    expect(withAmount.body.error.details.fields).toEqual([{ field: 'amount', reason: 'unknown_field' }]);
    const withoutKey = await web(http().post('/api/v1/payment/payments')).send({
      subjectType: 'billing_invoice',
      subjectId: MISSION_ID,
    });
    expect(withoutKey.status).toBe(400);
    expect(payment.stub.calls).toHaveLength(0);
  });

  it('erreurs métier de payment transmises telles quelles (404 hors périmètre, 422 rien à payer)', async () => {
    payment.stub.on('getMyPayment', () =>
      Promise.reject(AppError.notFound('PAYMENT_NOT_FOUND', 'Ce paiement est introuvable.')),
    );
    const missing = await web(http().get(`/api/v1/payment/payments/${PAYMENT_ID}`));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('PAYMENT_NOT_FOUND');
    payment.stub.on('createPayment', () =>
      Promise.reject(AppError.precondition('PAYMENT_NOTHING_DUE', 'Rien à payer.')),
    );
    const nothing = await web(http().post('/api/v1/payment/payments'))
      .set('Idempotency-Key', 'pay-key-0002')
      .send({ subjectType: 'billing_invoice', subjectId: MISSION_ID });
    expect(nothing.status).toBe(422);
  });

  it('notification FedaPay : publique, corps exact et signature transmis, aucune interprétation', async () => {
    const raw = '{"name":"transaction.approved","entity":{"id":104571},  "extra":"é"}';
    const res = await http()
      .post('/api/v1/payment/webhooks/fedapay')
      .set('Content-Type', 'application/json')
      .set('X-FEDAPAY-SIGNATURE', 't=1761900000,s=abc')
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const call = payment.stub.last('receiveProviderNotification')!;
    expect(call.request['provider']).toBe('fedapay');
    expect(call.request['signature']).toBe('t=1761900000,s=abc');
    expect(Buffer.from(call.request['payload'] as Uint8Array).toString('utf8')).toBe(raw);
    expect(call.context?.user).toBeUndefined();
  });

  it('notification : signature absente 400 ; signature refusée par payment 400 ; trop grosse 413', async () => {
    const unsigned = await http().post('/api/v1/payment/webhooks/fedapay').send({ name: 'x' });
    expect(unsigned.status).toBe(400);
    payment.stub.on('receiveProviderNotification', () =>
      Promise.reject(AppError.invalid('PAYMENT_WEBHOOK_SIGNATURE_INVALID', 'Signature fausse.')),
    );
    const forged = await http()
      .post('/api/v1/payment/webhooks/fedapay')
      .set('X-FEDAPAY-SIGNATURE', 't=1,s=00')
      .send({ name: 'x' });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    const huge = await http()
      .post('/api/v1/payment/webhooks/fedapay')
      .set('X-FEDAPAY-SIGNATURE', 't=1,s=00')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ name: 'x'.repeat(70 * 1024) }));
    expect(huge.status).toBe(413);
  });

  it('simulation : transmise en développement, 404 en production sans appel à payment', async () => {
    const dev = await web(http().post(`/api/v1/payment/payments/${PAYMENT_ID}/simulate`)).send({
      outcome: 'succeeded',
    });
    expect(dev.status).toBe(200);
    expect(dev.body).toMatchObject({ status: 'succeeded', checkoutUrl: null });
    payment.stub.reset();
    const prod = await web(http(production).post(`/api/v1/payment/payments/${PAYMENT_ID}/simulate`)).send({
      outcome: 'succeeded',
    });
    expect(prod.status).toBe(404);
    expect(prod.body.error.code).toBe('PAYMENT_SIMULATION_DISABLED');
    expect(payment.stub.calls).toHaveLength(0);
  });

  it('back-office : finance_officer avec filtres ; superviseur du Nettoyage refusé', async () => {
    const res = await http()
      .get(
        `/api/v1/admin/payment/payments?status=pending&subjectType=cleaning_mission&subjectId=${MISSION_ID}`,
      )
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${finance}`);
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe(PAYMENT_ID);
    expect(payment.stub.last('listPayments')!.request).toMatchObject({
      status: 'pending',
      subjectType: 'cleaning_mission',
      subjectId: MISSION_ID,
    });
    const refused = await http()
      .get('/api/v1/admin/payment/payments')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${supervisor}`);
    expect(refused.status).toBe(403);
  });

  it('limite payment_create : par utilisateur, 429 au-delà, sans appel à payment', async () => {
    const create = (token: string, key: string) =>
      web(http(limited).post('/api/v1/payment/payments'), token)
        .set('Idempotency-Key', key)
        .send({ subjectType: 'billing_invoice', subjectId: MISSION_ID });
    expect((await create(customer, 'limit-key-0001')).status).toBe(200);
    expect((await create(customer, 'limit-key-0002')).status).toBe(200);
    const refused = await create(customer, 'limit-key-0003');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('GATEWAY_RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(payment.stub.calls.filter((call) => call.method === 'createPayment')).toHaveLength(2);
    const other = await keys.accessToken({ subject: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e77' });
    expect((await create(other, 'limit-key-0004')).status).toBe(200);
  });

  it('limite payment_webhook : par adresse IP, 429 au-delà, sans appel à payment', async () => {
    const notify = (ip: string) =>
      http(limited)
        .post('/api/v1/payment/webhooks/fedapay')
        .set('X-Forwarded-For', ip)
        .set('X-FEDAPAY-SIGNATURE', 't=1,s=00')
        .send({ name: 'transaction.approved' });
    expect((await notify('198.51.100.7')).status).toBe(200);
    expect((await notify('198.51.100.7')).status).toBe(200);
    expect((await notify('198.51.100.7')).status).toBe(429);
    expect(payment.stub.calls.filter((call) => call.method === 'receiveProviderNotification')).toHaveLength(
      2,
    );
    expect((await notify('198.51.100.8')).status).toBe(200);
  });
});
