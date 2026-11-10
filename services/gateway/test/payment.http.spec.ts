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
import {
  MISSION_ID,
  PAYMENT_ID,
  type PaymentServer,
  protoPayment,
  startPaymentStub,
} from './support/payment-stub';

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
  let financeWithoutMfa: string;
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
        // Redis injoignable : limites en mémoire (repli).
        REDIS_URL: 'redis://127.0.0.1:1',
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
    financeWithoutMfa = await keys.accessToken({
      claims: {
        client_id: 'backoffice',
        mfa: false,
        roles: [{ role: 'finance_officer', scopeType: 'global' }],
      },
    });
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
      underReview: false,
    });
    // Noms du payeur et traitement d'un écart de montant : back-office seulement.
    for (const field of [
      'customerName',
      'organizationName',
      'mismatchResolvedAt',
      'mismatchResolvedBy',
      'mismatchResolutionNote',
    ]) {
      expect(res.body).not.toHaveProperty(field);
    }
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
    // Paiement réussi pas encore enregistré par cleaning ou billing : 409 (ADR-032).
    payment.stub.on('createPayment', () =>
      Promise.reject(AppError.conflict('PAYMENT_ALREADY_RECEIVED', 'Paiement déjà reçu.')),
    );
    const received = await web(http().post('/api/v1/payment/payments'))
      .set('Idempotency-Key', 'pay-key-0003')
      .send({ subjectType: 'billing_invoice', subjectId: MISSION_ID });
    expect(received.status).toBe(409);
    expect(received.body.error.code).toBe('PAYMENT_ALREADY_RECEIVED');
    // Toujours pas enregistré après le délai : 409 aussi, avec le code qui oriente vers le support.
    payment.stub.on('createPayment', () =>
      Promise.reject(AppError.conflict('PAYMENT_RECONCILIATION_PENDING', 'Contactez le support.')),
    );
    const pending = await web(http().post('/api/v1/payment/payments'))
      .set('Idempotency-Key', 'pay-key-0004')
      .send({ subjectType: 'billing_invoice', subjectId: MISSION_ID });
    expect(pending.status).toBe(409);
    expect(pending.body.error).toMatchObject({
      code: 'PAYMENT_RECONCILIATION_PENDING',
      message: 'Contactez le support.',
    });
    // Écart de montant pas encore traité par la finance : 409, contacter le support (ADR-032).
    payment.stub.on('createPayment', () =>
      Promise.reject(
        AppError.conflict(
          'PAYMENT_UNDER_REVIEW',
          'Un paiement est en cours de vérification ; contactez le support KSP.',
        ),
      ),
    );
    const review = await web(http().post('/api/v1/payment/payments'))
      .set('Idempotency-Key', 'pay-key-0005')
      .send({ subjectType: 'billing_invoice', subjectId: MISSION_ID });
    expect(review.status).toBe(409);
    expect(review.body.error).toMatchObject({
      code: 'PAYMENT_UNDER_REVIEW',
      message: 'Un paiement est en cours de vérification ; contactez le support KSP.',
    });
  });

  it('écart de montant en revue visible côté client (underReview), sans le détail du traitement', async () => {
    payment.stub.on('getMyPayment', async () => ({
      payment: {
        ...protoPayment,
        status: 'amount_mismatch',
        checkoutUrl: '',
        underReview: true,
        // Jamais renvoyés par payment côté client ; la gateway ne les exposerait pas non plus.
        mismatchResolutionNote: 'note interne',
      },
    }));
    const res = await web(http().get(`/api/v1/payment/payments/${PAYMENT_ID}`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'amount_mismatch', underReview: true });
    expect(res.body).not.toHaveProperty('mismatchResolutionNote');
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
    // Noms lus dans identity par payment (ADR-029) ; vide → null.
    expect(res.body.data[0]).toMatchObject({ customerName: 'Koffi Adjovi', organizationName: null });
    expect(payment.stub.last('listPayments')!.request).toMatchObject({
      status: 'pending',
      subjectType: 'cleaning_mission',
      subjectId: MISSION_ID,
    });
    expect(payment.stub.last('listPayments')!.request['underReview']).toBeUndefined();
    expect(res.body.data[0]).toMatchObject({
      underReview: false,
      mismatchResolvedAt: null,
      mismatchResolvedBy: null,
      mismatchResolutionNote: null,
    });
    const refused = await http()
      .get('/api/v1/admin/payment/payments')
      .set('Origin', ORIGINS.backoffice)
      .set('Authorization', `Bearer ${supervisor}`);
    expect(refused.status).toBe(403);
  });

  it('back-office : filtre underReview (true, false), valeur inconnue refusée', async () => {
    const list = (query: string) =>
      http()
        .get(`/api/v1/admin/payment/payments?${query}`)
        .set('Origin', ORIGINS.backoffice)
        .set('Authorization', `Bearer ${finance}`);
    expect((await list('underReview=true')).status).toBe(200);
    expect(payment.stub.last('listPayments')!.request['underReview']).toBe(true);
    expect((await list('underReview=false&status=amount_mismatch')).status).toBe(200);
    expect(payment.stub.last('listPayments')!.request).toMatchObject({
      underReview: false,
      status: 'amount_mismatch',
    });
    payment.stub.reset();
    const invalid = await list('underReview=oui');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.fields).toEqual([{ field: 'underReview', reason: 'invalid_value' }]);
    expect(payment.stub.calls).toHaveLength(0);
  });

  describe('traitement d’un écart de montant par la finance', () => {
    const URL = `/api/v1/admin/payment/payments/${PAYMENT_ID}/resolve-mismatch`;
    const NOTE = 'Remboursé au client par FedaPay le 05/11.';
    const resolve = (token = finance) =>
      http().post(URL).set('Origin', ORIGINS.backoffice).set('Authorization', `Bearer ${token}`);

    it('note et clé transmises, utilisateur dans le contexte, détail du traitement renvoyé', async () => {
      const res = await resolve().set('Idempotency-Key', 'res-key-0001').send({ note: NOTE });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: PAYMENT_ID,
        status: 'amount_mismatch',
        underReview: false,
        checkoutUrl: null,
        mismatchResolvedAt: '2026-11-05T10:00:00.000Z',
        mismatchResolvedBy: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e99',
        mismatchResolutionNote: NOTE,
      });
      const call = payment.stub.last('resolveAmountMismatch')!;
      expect(call.request).toEqual({ paymentId: PAYMENT_ID, note: NOTE, idempotencyKey: 'res-key-0001' });
      expect(call.context?.user?.roles).toEqual([expect.objectContaining({ role: 'finance_officer' })]);
    });

    it('clé facultative : sans en-tête, transmise vide', async () => {
      expect((await resolve().send({ note: NOTE })).status).toBe(200);
      expect(payment.stub.last('resolveAmountMismatch')!.request['idempotencyKey']).toBe('');
    });

    it.each([
      ['note absente', {}, 'note', 'invalid_type'],
      ['note vide', { note: '' }, 'note', 'too_small'],
      ['note trop longue', { note: 'x'.repeat(501) }, 'note', 'too_big'],
      ['champ inconnu', { note: NOTE, amount: 100 }, 'amount', 'unknown_field'],
    ])('%s : 400 sans appel à payment', async (_label, body, field, reason) => {
      const res = await resolve().send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.details.fields).toEqual([{ field, reason }]);
      expect(payment.stub.calls).toHaveLength(0);
    });

    it('note de 500 caractères acceptée ; clé ou identifiant mal formés refusés', async () => {
      expect((await resolve().send({ note: 'x'.repeat(500) })).status).toBe(200);
      payment.stub.reset();
      expect((await resolve().set('Idempotency-Key', 'court').send({ note: NOTE })).status).toBe(400);
      const badId = await http()
        .post('/api/v1/admin/payment/payments/abc/resolve-mismatch')
        .set('Origin', ORIGINS.backoffice)
        .set('Authorization', `Bearer ${finance}`)
        .send({ note: NOTE });
      expect(badId.status).toBe(400);
      expect(payment.stub.calls).toHaveLength(0);
    });

    it('accès : superviseur du Nettoyage, client et finance sans double authentification refusés', async () => {
      expect((await resolve(supervisor).send({ note: NOTE })).status).toBe(403);
      const noMfa = await resolve(financeWithoutMfa).send({ note: NOTE });
      expect(noMfa.status).toBe(403);
      expect(noMfa.body.error.code).toBe('GATEWAY_MFA_REQUIRED');
      expect((await web(http().post(URL)).send({ note: NOTE })).status).toBe(403);
      expect((await http().post(URL).set('Origin', ORIGINS.backoffice).send({ note: NOTE })).status).toBe(
        401,
      );
      expect(payment.stub.calls).toHaveLength(0);
    });

    it('refus de payment transmis (422 pas un écart, 409 déjà traité)', async () => {
      payment.stub.on('resolveAmountMismatch', () =>
        Promise.reject(AppError.precondition('PAYMENT_NOT_AMOUNT_MISMATCH', 'Pas un écart.')),
      );
      const notMismatch = await resolve().send({ note: NOTE });
      expect(notMismatch.status).toBe(422);
      expect(notMismatch.body.error.code).toBe('PAYMENT_NOT_AMOUNT_MISMATCH');
      payment.stub.on('resolveAmountMismatch', () =>
        Promise.reject(AppError.conflict('PAYMENT_MISMATCH_ALREADY_RESOLVED', 'Déjà traité.')),
      );
      const twice = await resolve().send({ note: NOTE });
      expect(twice.status).toBe(409);
      expect(twice.body.error.code).toBe('PAYMENT_MISMATCH_ALREADY_RESOLVED');
    });
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
