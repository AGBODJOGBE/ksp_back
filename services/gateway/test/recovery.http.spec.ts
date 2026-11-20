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
import { DEBTOR_TOKEN, RECOVERY_ID, type RecoveryServer, startRecoveryStub } from './support/recovery-stub';

/**
 * Ce que la gateway transmet à recovery (ADR-060, ADR-061) : paramètres du chemin et de la requête
 * rangés dans la demande gRPC, corps validé (étalé ou rangé dans son champ), clé d'idempotence,
 * session du débiteur en métadonnée ; réponses limitées aux champs du contrat.
 */
describe('gateway → recovery', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let recovery: RecoveryServer;
  let app: NestExpressApplication;
  let withoutRecovery: NestExpressApplication;
  let customer: string;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    recovery = await startRecoveryStub(keys);
    app = await startGateway({
      identityUrl: identity.url,
      recoveryUrl: recovery.url,
      keys,
      env: { RATE_LIMIT_RECOVERY_DEBTOR_CODE_REQUEST_PER_MINUTE: '2' },
    });
    withoutRecovery = await startGateway({ identityUrl: identity.url, keys });
    customer = await keys.accessToken();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await withoutRecovery?.close();
    await identity?.close();
    await recovery?.close();
  });

  beforeEach(() => recovery.stub.reset());

  const web = (req: request.Test) => req.set('Origin', ORIGINS.web).set('X-Forwarded-For', '192.0.2.10');
  const authed = (req: request.Test) => web(req).set('Authorization', `Bearer ${customer}`);

  it('liste des dossiers : filtres et page rangés dans la demande, utilisateur transmis', async () => {
    const res = await authed(
      request(app.getHttpServer()).get('/api/v1/recovery/cases?status=active&search=SARL&limit=10'),
    );
    expect(res.status).toBe(200);
    const call = recovery.stub.last('listMyCases');
    expect(call?.request).toMatchObject({
      filter: { statuses: ['active'], search: 'SARL' },
      page: { limit: 10 },
    });
    expect(call?.context?.user?.userId).toBe(USER_ID);
    expect(res.body.cases[0]).toMatchObject({ id: RECOVERY_ID, due: { currency: 'XOF' } });
  });

  it('préférences : le corps est rangé dans son champ ; un champ inconnu est refusé sans appel', async () => {
    const preferences = {
      b2bScale: {
        acceptsPaymentPlan: true,
        maxDurationMonths: 12,
        minFirstPaymentBps: 1000,
        firstPaymentWithinDays: 15,
        minInstallment: { amount: 25000, currency: 'XOF' },
        maxDiscountBps: 0,
      },
      b2cScale: {
        acceptsPaymentPlan: true,
        maxDurationMonths: 6,
        minFirstPaymentBps: 1000,
        firstPaymentWithinDays: 15,
        minInstallment: { amount: 5000, currency: 'XOF' },
        maxDiscountBps: 500,
      },
      notifyUserIds: [],
    };
    const ok = await authed(request(app.getHttpServer()).put('/api/v1/recovery/preferences')).send(
      preferences,
    );
    expect(ok.status).toBe(200);
    expect(recovery.stub.last('updateMyPreferences')?.request['preferences']).toMatchObject({
      b2cScale: { maxDiscountBps: 500 },
    });

    const refused = await authed(request(app.getHttpServer()).put('/api/v1/recovery/preferences')).send({
      ...preferences,
      commissionBps: 0,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
    expect(recovery.stub.calls).toHaveLength(1);
  });

  it('débiteur : session transmise en métadonnée, clé d’idempotence dans la demande', async () => {
    const res = await web(request(app.getHttpServer()).post('/api/v1/recovery/debtor/payments'))
      .set('X-Debtor-Session', DEBTOR_TOKEN)
      .set('Idempotency-Key', 'cle-0192f1c4-0002')
      .send({ amount: { amount: 50000, currency: 'XOF' } });
    expect(res.status).toBe(200);
    const call = recovery.stub.last('createDebtorPayment');
    expect(call?.debtorSession).toBe(DEBTOR_TOKEN);
    expect(call?.request).toMatchObject({ idempotencyKey: 'cle-0192f1c4-0002', amount: { amount: 50000 } });
  });

  it('débiteur : session absente ou mal formée, 401 sans appeler recovery', async () => {
    for (const session of [undefined, 'court']) {
      const req = web(request(app.getHttpServer()).get('/api/v1/recovery/debtor/case'));
      const res = await (session ? req.set('X-Debtor-Session', session) : req);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('RECOVERY_DEBTOR_SESSION_INVALID');
    }
    expect(recovery.stub.calls).toHaveLength(0);
  });

  it('erreur métier de recovery transmise telle quelle', async () => {
    recovery.stub.on('verifyDebtorAccessCode', () =>
      Promise.reject(
        AppError.invalid('RECOVERY_DEBTOR_CODE_INVALID', 'Code incorrect.', { attemptsLeft: 4 }),
      ),
    );
    const res = await web(
      request(app.getHttpServer()).post(`/api/v1/recovery/debtor/access/${DEBTOR_TOKEN}/verify`),
    ).send({ code: '482913' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'RECOVERY_DEBTOR_CODE_INVALID',
      details: { attemptsLeft: 4 },
    });
    expect(recovery.stub.last('verifyDebtorAccessCode')?.request).toEqual({
      token: DEBTOR_TOKEN,
      code: '482913',
    });
  });

  it('lien du débiteur mal formé : 404 uniforme, sans appel à recovery ni reprise du jeton', async () => {
    const bad = ['court', `${DEBTOR_TOKEN}x`, `${DEBTOR_TOKEN.slice(0, 42)}.`];
    for (const token of bad) {
      const responses = await Promise.all([
        web(request(app.getHttpServer()).get(`/api/v1/recovery/debtor/access/${token}`)),
        // Corps invalide aussi : le jeton est contrôlé d'abord, aucun indice sur le reste.
        web(request(app.getHttpServer()).post(`/api/v1/recovery/debtor/access/${token}/verify`)).send({
          code: 'abc',
        }),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('RECOVERY_DEBTOR_LINK_INVALID');
        expect(JSON.stringify(res.body)).not.toContain(token);
      }
    }
    expect(recovery.stub.calls).toHaveLength(0);
  });

  it('limite des codes du débiteur : par adresse IP, 429 au-delà, sans appel à recovery', async () => {
    const send = () =>
      request(app.getHttpServer())
        .post(`/api/v1/recovery/debtor/access/${DEBTOR_TOKEN}/code`)
        .set('Origin', ORIGINS.web)
        .set('X-Forwarded-For', '192.0.2.30');
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('GATEWAY_RATE_LIMITED');
    expect(recovery.stub.calls).toHaveLength(2);
  });

  describe('rôles et double authentification', () => {
    const now = () => Math.floor(Date.now() / 1000);
    /** Jeton du back-office : rôles donnés, double authentification faite il y a `mfaAge` secondes. */
    const staff = (roles: string[], mfaAge = 0) =>
      keys.accessToken({
        claims: {
          client_id: 'backoffice',
          mfa: true,
          auth_time: now() - mfaAge,
          roles: roles.map((role) => ({ role, scopeType: 'global' })),
        },
      });
    const partner = (role: string) =>
      keys.accessToken({ claims: { roles: [{ role, scopeType: 'global' }] } });
    const backoffice = (req: request.Test, bearer: string) =>
      req
        .set('Origin', ORIGINS.backoffice)
        .set('X-Forwarded-For', '192.0.2.40')
        .set('Authorization', `Bearer ${bearer}`);
    const CASE = `/api/v1/admin/recovery/cases/${RECOVERY_ID}`;

    it('rôle hors de la liste de la route : 403 sans appel à recovery', async () => {
      const http = () => request(app.getHttpServer());
      const refusals: [() => request.Test, string][] = [
        // La finance lit les dossiers mais ne statue pas sur leur recevabilité.
        [() => http().post(`${CASE}/assessment`), await staff(['finance_officer'])],
        // Un chargé ne touche pas à la tarification.
        [() => http().post('/api/v1/admin/recovery/pricing-rules'), await staff(['recovery_agent'])],
        // Un chargé n'enregistre pas d'espèces : la finance seule.
        [() => http().post(`${CASE}/offline-payments`), await staff(['recovery_agent'])],
        // Un huissier partenaire n'entre pas au back-office.
        [() => http().get('/api/v1/admin/recovery/cases'), await partner('recovery_bailiff')],
        // Un client n'entre pas au back-office.
        [() => http().get('/api/v1/admin/recovery/cases'), customer],
      ];
      for (const [req, bearer] of refusals) {
        const res = await backoffice(req().set('Idempotency-Key', 'cle-0192f1c4-0004'), bearer).send({});
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('GATEWAY_FORBIDDEN');
      }
      // Routes des partenaires : ni client, ni chargé du back-office.
      for (const bearer of [customer, await staff(['recovery_agent', 'super_admin'])]) {
        const res = await authed(
          request(app.getHttpServer()).get('/api/v1/recovery/partner/assignments'),
        ).set('Authorization', `Bearer ${bearer}`);
        expect(res.status).toBe(403);
      }
      expect(recovery.stub.calls).toHaveLength(0);
    });

    it('partenaire : ses routes seulement, rôle transmis à recovery', async () => {
      const lawyer = await partner('recovery_lawyer');
      const res = await web(request(app.getHttpServer()).get('/api/v1/recovery/partner/assignments')).set(
        'Authorization',
        `Bearer ${lawyer}`,
      );
      expect(res.status).toBe(200);
      expect(recovery.stub.last('listMyAssignments')?.context?.user?.roles).toEqual([
        expect.objectContaining({ role: 'recovery_lawyer' }),
      ]);
    });

    it('action sensible : double authentification de moins de 10 minutes', async () => {
      const legal = await staff(['legal_officer'], 20 * 60);
      const read = await backoffice(
        request(app.getHttpServer()).get(`${CASE}/partner-suggestions?kind=bailiff`),
        legal,
      );
      expect(read.status).toBe(200);
      const assign = await backoffice(request(app.getHttpServer()).post(`${CASE}/partner`), legal).send({
        partnerId: RECOVERY_ID,
      });
      expect(assign.status).toBe(403);
      expect(assign.body.error.code).toBe('GATEWAY_MFA_REQUIRED');
      expect(recovery.stub.calls.map((call) => call.method)).toEqual(['suggestPartners']);
    });
  });

  it('service recovery absent : 503 comme pour un service indisponible', async () => {
    const res = await authed(
      request(withoutRecovery.getHttpServer()).get(`/api/v1/recovery/cases/${RECOVERY_ID}`),
    );
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('RECOVERY_UNAVAILABLE');
  });
});
