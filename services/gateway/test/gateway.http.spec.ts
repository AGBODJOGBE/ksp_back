import { identityV1 } from '@ksp/contracts';
import { AppError } from '@ksp/platform';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { generateKeyPair } from 'jose';
import request from 'supertest';
import {
  freePort,
  type IdentityServer,
  ORIGINS,
  SESSION_ID,
  startGateway,
  startIdentityStub,
  TestKeys,
  USER_ID,
} from './support/harness';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OTP = '/api/v1/identity/otp/request';
const VERIFY = '/api/v1/identity/otp/verify';
const REFRESH = '/api/v1/identity/token/refresh';
const LOGOUT = '/api/v1/identity/logout';
const ME = '/api/v1/identity/me';

/** Chaque test a sa propre adresse IP (X-Forwarded-For, crue depuis la boucle locale) : compteurs sÃ©parÃ©s. */
let ipSeq = 0;
const nextIp = () => `203.0.113.${++ipSeq}`;

describe('gateway : routes identity de bout en bout (serveur gRPC identity simulÃ©)', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let app: NestExpressApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    app = await startGateway({ identityUrl: identity.url, keys });
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
    await identity?.close();
  });

  beforeEach(() => identity.stub.reset());

  const web = (req: request.Test) => req.set('Origin', ORIGINS.web).set('X-Forwarded-For', nextIp());
  const mobile = (req: request.Test) => req.set('X-App-Version', '1.4.2').set('X-Forwarded-For', nextIp());
  let token: string;
  beforeAll(async () => {
    token = await keys.accessToken();
  });
  const bearer = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', nextIp());

  describe('demande de code (UC-GW-01)', () => {
    it('traduit la requÃªte en gRPC et transmet le contexte du client', async () => {
      const ip = nextIp();
      const res = await http
        .post(OTP)
        .set('Origin', ORIGINS.web)
        .set('X-Forwarded-For', ip)
        .set('User-Agent', 'Mozilla/5.0 (Android 14)')
        .send({ phone: '+2290197000045', channel: 'whatsapp' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
        maskedTarget: '+229********45',
        channel: 'whatsapp',
        expiresInSeconds: 300,
        resendAfterSeconds: 60,
      });
      const correlationId = res.headers['x-correlation-id'];
      expect(correlationId).toMatch(UUID);

      const call = identity.stub.last('requestOtp')!;
      expect(call.request).toMatchObject({
        phoneE164: '+2290197000045',
        channel: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
        purpose: identityV1.OtpPurpose.OTP_PURPOSE_LOGIN,
      });
      expect(call.context).toMatchObject({
        correlationId,
        client: { ip, userAgent: 'Mozilla/5.0 (Android 14)' },
        // Jeton de service de la gateway vÃ©rifiÃ© par identity (ADR-022).
        callerService: 'gateway',
      });
      expect(call.context?.user).toBeUndefined();
    });

    it('canal non prÃ©cisÃ© : identity choisit', async () => {
      await mobile(http.post(OTP)).send({ phone: '+2290197000045' }).expect(200);
      expect(identity.stub.last('requestOtp')?.request['channel']).toBe(
        identityV1.OtpChannel.OTP_CHANNEL_UNSPECIFIED,
      );
    });

    it('ne reprend jamais lâ€™identifiant de corrÃ©lation envoyÃ© par le client', async () => {
      const res = await web(http.post(OTP))
        .set('X-Correlation-Id', 'client-choice')
        .send({ phone: '+2290197000045' });
      expect(res.headers['x-correlation-id']).toMatch(UUID);
      expect(identity.stub.last('requestOtp')?.context?.correlationId).toBe(res.headers['x-correlation-id']);
    });

    it('client inconnu (ni origine autorisÃ©e, ni application) : 400 GATEWAY_CLIENT_UNKNOWN', async () => {
      for (const origin of [undefined, 'https://evil.example']) {
        const req = http.post(OTP).set('X-Forwarded-For', nextIp());
        if (origin) req.set('Origin', origin);
        const res = await req.send({ phone: '+2290197000045' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'GATEWAY_CLIENT_UNKNOWN' });
      }
      expect(identity.stub.calls).toEqual([]);
    });

    it('champ inconnu ou numÃ©ro mal formÃ© : 400 GATEWAY_VALIDATION_FAILED, sans appel Ã  identity', async () => {
      const res = await web(http.post(OTP)).send({ phone: '0197000045', role: 'admin' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
      expect(res.body.error.details.fields).toEqual(
        expect.arrayContaining([
          { field: 'role', reason: 'unknown_field' },
          { field: 'phone', reason: 'invalid_format' },
        ]),
      );
      expect(identity.stub.calls).toEqual([]);
    });

    it('JSON mal formÃ© : 400 ; corps de plus de 1 Mo : 413', async () => {
      const broken = await web(http.post(OTP)).set('Content-Type', 'application/json').send('{"phone":');
      expect(broken.status).toBe(400);
      expect(broken.body.error).toMatchObject({ code: 'GATEWAY_VALIDATION_FAILED' });
      expect(broken.body.error.correlationId).toBe(broken.headers['x-correlation-id']);

      const huge = await web(http.post(OTP)).send({ phone: '+2290197000045', pad: 'x'.repeat(1024 * 1024) });
      expect(huge.status).toBe(413);
      expect(huge.body.error.code).toBe('GATEWAY_PAYLOAD_TOO_LARGE');
    });

    it('limite dâ€™identity par numÃ©ro : 429 avec Retry-After repris de ses dÃ©tails', async () => {
      identity.stub.on('requestOtp', () =>
        Promise.reject(
          AppError.rateLimited('IDENTITY_OTP_RATE_LIMITED', 'Trop de codes demandÃ©s.', {
            retryAfterSeconds: 45,
          }),
        ),
      );
      const res = await web(http.post(OTP)).send({ phone: '+2290197000045' });
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('45');
      expect(res.body.error).toMatchObject({
        code: 'IDENTITY_OTP_RATE_LIMITED',
        details: { retryAfterSeconds: 45 },
      });
    });
  });

  describe('validation du code et cookie de renouvellement (UC-GW-13)', () => {
    it('web : jeton de renouvellement dans un cookie HttpOnly, absent du corps', async () => {
      const res = await web(http.post(VERIFY))
        .set('User-Agent', 'Mozilla/5.0')
        .send({ challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f', code: '482913' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'authenticated',
        sessionId: SESSION_ID,
        isNewUser: true,
        profileIncomplete: true,
        user: { id: USER_ID, firstName: null, email: null, phone: '+2290197000045', status: 'active' },
        activeContext: { type: 'individual', organizationId: null },
      });
      expect(res.body).not.toHaveProperty('refreshToken');
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/^__Secure-ksp_rt=rt-new; /);
      expect(cookie).toContain('Path=/api/v1/identity/token');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1]);
      expect(maxAge).toBeGreaterThan(30 * 24 * 3600 - 60);
      expect(maxAge).toBeLessThanOrEqual(30 * 24 * 3600);
      expect(identity.stub.last('verifyOtp')?.request).toMatchObject({
        clientKind: identityV1.ClientKind.CLIENT_KIND_WEB,
        deviceLabel: '',
      });
    });

    it('mobile : jeton dans le corps, aucun cookie', async () => {
      const res = await mobile(http.post(VERIFY)).send({
        challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
        code: '482913',
        deviceLabel: 'TÃ©lÃ©phone Android',
      });
      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toBe('rt-new');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(identity.stub.last('verifyOtp')?.request).toMatchObject({
        clientKind: identityV1.ClientKind.CLIENT_KIND_MOBILE,
        deviceLabel: 'TÃ©lÃ©phone Android',
      });
    });

    it('back-office : cookie dÃ©diÃ© ; double authentification demandÃ©e transmise sans cookie', async () => {
      const opened = await http
        .post(VERIFY)
        .set('Origin', ORIGINS.backoffice)
        .set('X-Forwarded-For', nextIp())
        .send({ challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f', code: '482913' });
      expect(String(opened.headers['set-cookie'])).toMatch(/^__Secure-ksp_admin_rt=rt-new; /);
      expect(identity.stub.last('verifyOtp')?.request['clientKind']).toBe(
        identityV1.ClientKind.CLIENT_KIND_BACKOFFICE,
      );

      identity.stub.on('verifyOtp', async () => ({
        result: {
          mfaRequired: {
            mfaToken: 'mfa_2b3c4d5e6f',
            expiresAt: '2026-10-17T10:05:00.000Z',
            methods: [identityV1.MfaMethod.MFA_METHOD_TOTP, identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE],
            enrollmentRequired: true,
          },
        },
        isNewUser: false,
      }));
      const mfa = await http
        .post(VERIFY)
        .set('Origin', ORIGINS.backoffice)
        .set('X-Forwarded-For', nextIp())
        .send({ challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f', code: '482913' });
      expect(mfa.status).toBe(200);
      expect(mfa.body).toEqual({
        status: 'mfa_required',
        mfaToken: 'mfa_2b3c4d5e6f',
        expiresAt: '2026-10-17T10:05:00.000Z',
        methods: ['totp', 'recovery_code'],
        enrollmentRequired: true,
      });
      expect(mfa.headers['set-cookie']).toBeUndefined();
    });

    it.each([
      [AppError.invalid('IDENTITY_OTP_INVALID', 'Le code est incorrect.', { attemptsRemaining: 3 }), 400],
      [AppError.precondition('IDENTITY_OTP_EXPIRED', 'Le code a expirÃ©.'), 422],
      [AppError.precondition('IDENTITY_OTP_TOO_MANY_ATTEMPTS', 'Code annulÃ©.'), 422],
      [AppError.forbidden('IDENTITY_BACKOFFICE_FORBIDDEN', 'AccÃ¨s refusÃ©.'), 403],
    ])('erreur dâ€™identity %# : code transmis, statut HTTP de la table', async (error, status) => {
      identity.stub.on('verifyOtp', () => Promise.reject(error));
      const res = await web(http.post(VERIFY)).send({
        challengeId: '0192f1c4-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
        code: '000000',
      });
      expect(res.status).toBe(status);
      expect(res.body).toEqual({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          correlationId: res.headers['x-correlation-id'],
        },
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('renouvellement', () => {
    it('web : lit le cookie, le remplace par le nouveau jeton', async () => {
      const res = await web(http.post(REFRESH)).set('Cookie', '__Secure-ksp_rt=rt-old; theme=dark');
      expect(res.status).toBe(200);
      expect(identity.stub.last('refreshSession')?.request).toEqual({ refreshToken: 'rt-old' });
      expect(String(res.headers['set-cookie'])).toMatch(/^__Secure-ksp_rt=rt-rotated; /);
      expect(res.body).not.toHaveProperty('refreshToken');
      expect(res.body).not.toHaveProperty('isNewUser');
    });

    it('back-office : lit son propre cookie, jamais celui des sites', async () => {
      const res = await http
        .post(REFRESH)
        .set('Origin', ORIGINS.backoffice)
        .set('X-Forwarded-For', nextIp())
        .set('Cookie', '__Secure-ksp_rt=rt-web');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('GATEWAY_TOKEN_MISSING');
      expect(identity.stub.calls).toEqual([]);
    });

    it('web : sans cookie â†’ 401 ; jeton dans le corps â†’ 400', async () => {
      const missing = await web(http.post(REFRESH));
      expect(missing.status).toBe(401);
      expect(missing.body.error.code).toBe('GATEWAY_TOKEN_MISSING');
      const inBody = await web(http.post(REFRESH))
        .set('Cookie', '__Secure-ksp_rt=rt-old')
        .send({ refreshToken: 'rt-old' });
      expect(inBody.status).toBe(400);
      expect(inBody.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
      expect(identity.stub.calls).toEqual([]);
    });

    it('mobile : jeton dans le corps et dans la rÃ©ponse', async () => {
      const res = await mobile(http.post(REFRESH)).send({ refreshToken: 'rt-old' });
      expect(res.status).toBe(200);
      expect(res.body.refreshToken).toBe('rt-rotated');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('jeton rÃ©utilisÃ© (vol) : 401 et cookie effacÃ©', async () => {
      identity.stub.on('refreshSession', () =>
        Promise.reject(AppError.unauthenticated('IDENTITY_REFRESH_TOKEN_REUSED', 'Session rÃ©voquÃ©e.')),
      );
      const res = await web(http.post(REFRESH)).set('Cookie', '__Secure-ksp_rt=rt-stolen');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('IDENTITY_REFRESH_TOKEN_REUSED');
      expect(String(res.headers['set-cookie'])).toMatch(
        /^__Secure-ksp_rt=; Path=\/api\/v1\/identity\/token; Max-Age=0/,
      );
    });
  });

  describe('routes connectÃ©es (UC-GW-02)', () => {
    it('profil : utilisateur vÃ©rifiÃ© transmis dans les mÃ©tadonnÃ©es, jamais dans le message', async () => {
      const res = await bearer(http.get(ME)).send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        user: {
          id: USER_ID,
          status: 'active',
          firstName: null,
          lastName: null,
          phone: '+2290197000045',
          email: null,
          emailVerified: false,
          preferredLanguage: 'fr',
          createdAt: '2026-10-17T10:00:00.000Z',
        },
        profileIncomplete: true,
        pendingEmail: null,
        activeContext: { type: 'individual', organizationId: null },
      });
      const call = identity.stub.last('getMe')!;
      expect(call.request).toEqual({});
      expect(call.context?.user).toMatchObject({
        userId: USER_ID,
        sessionId: SESSION_ID,
        activeContext: 'personal',
        roles: [{ role: 'customer', scopeType: 'personal', scopeId: null }],
        mfa: false,
      });
    });

    it('modification : seuls les champs envoyÃ©s partent ; corps vide refusÃ©', async () => {
      const res = await bearer(http.patch(ME)).send({ firstName: 'Koffi' });
      expect(res.status).toBe(200);
      expect(res.body.user.firstName).toBe('Koffi');
      const sent = identity.stub.last('updateMe')?.request;
      expect(sent).toMatchObject({ firstName: 'Koffi' });
      expect(sent).not.toHaveProperty('lastName');
      expect(sent).not.toHaveProperty('preferredLanguage');

      const empty = await bearer(http.patch(ME)).send({});
      expect(empty.status).toBe(400);
      expect(empty.body.error.code).toBe('GATEWAY_VALIDATION_FAILED');
    });

    it('dÃ©connexion web : session de la requÃªte rÃ©voquÃ©e, cookie effacÃ©', async () => {
      const res = await bearer(http.post(LOGOUT)).set('Origin', ORIGINS.web).send({ scope: 'all_devices' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revokedSessions: 3 });
      expect(String(res.headers['set-cookie'])).toMatch(/^__Secure-ksp_rt=; .*Max-Age=0/);
      expect(identity.stub.last('logout')?.request).toEqual({
        scope: identityV1.LogoutScope.LOGOUT_SCOPE_ALL_DEVICES,
      });
      expect(identity.stub.last('logout')?.context?.user?.sessionId).toBe(SESSION_ID);
    });

    it('dÃ©connexion mobile : cet appareil par dÃ©faut, aucun cookie', async () => {
      const res = await bearer(http.post(LOGOUT)).set('X-App-Version', '1.4.2');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revokedSessions: 1 });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it.each([
      ['absent', async () => undefined, 'GATEWAY_TOKEN_MISSING'],
      [
        'expirÃ©',
        () => keys.accessToken({ expiresIn: Math.floor(Date.now() / 1000) - 120 }),
        'GATEWAY_TOKEN_EXPIRED',
      ],
      [
        'signÃ© par une autre clÃ©',
        async () => keys.accessToken({ key: (await generateKeyPair('ES256')).privateKey }),
        'GATEWAY_TOKEN_INVALID',
      ],
      [
        'dâ€™un autre type',
        () => keys.accessToken({ claims: { token_use: 'service' } }),
        'GATEWAY_TOKEN_INVALID',
      ],
    ])('jeton %s : 401 %s, sans appel Ã  identity', async (_label, make, code) => {
      const token = await make();
      const req = http.get(ME).set('X-Forwarded-For', nextIp());
      if (token) req.set('Authorization', `Bearer ${token}`);
      const res = await req;
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(code);
      expect(identity.stub.calls).toEqual([]);
    });
  });

  it('clÃ©s publiques : servies depuis le cache, avec Cache-Control', async () => {
    const res = await http.get('/.well-known/jwks.json').set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=600');
    expect(res.body).toEqual({ keys: [keys.accessJwk] });
  });

  describe('exploitation', () => {
    it('route inconnue : 404 au format commun', async () => {
      const res = await http.get('/api/v1/identity/admin').set('X-Forwarded-For', nextIp());
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject({ code: 'GATEWAY_ROUTE_NOT_FOUND' });
      expect(res.body.error.correlationId).toBe(res.headers['x-correlation-id']);
    });

    it('en-tÃªtes de sÃ©curitÃ©, aucune version de serveur, pas de cache', async () => {
      const res = await web(http.post(OTP)).send({ phone: '+2290197000045' });
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['strict-transport-security']).toContain('max-age=');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('CORS : origine autorisÃ©e avec cookie ; autre origine sans en-tÃªte CORS', async () => {
      const allowed = await http
        .options(REFRESH)
        .set('Origin', ORIGINS.web)
        .set('Access-Control-Request-Method', 'POST');
      expect(allowed.headers['access-control-allow-origin']).toBe(ORIGINS.web);
      expect(allowed.headers['access-control-allow-credentials']).toBe('true');

      const other = await http
        .options(REFRESH)
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(other.headers['access-control-allow-origin']).toBeUndefined();

      const exposed = await web(http.post(OTP)).send({ phone: '+2290197000045' });
      expect(exposed.headers['access-control-expose-headers']).toContain('X-Correlation-Id');
    });

    it('sondes de santÃ© : vivant, et prÃªt quand les clÃ©s publiques sont en cache', async () => {
      await http.get('/health/live').expect(200, { status: 'ok' });
      await http.get('/health/ready').expect(200, { ready: true, checks: { 'identity-keys': 'ok' } });
    });
  });
});

describe('gateway : limites dâ€™appels (UC-GW-04)', () => {
  let keys: TestKeys;
  let identity: IdentityServer;
  let app: NestExpressApplication;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    app = await startGateway({
      identityUrl: identity.url,
      keys,
      env: { RATE_LIMIT_AUTHENTICATED_PER_MINUTE: '2' },
    });
  });

  afterAll(async () => {
    await app?.close();
    await identity?.close();
  });

  it('demande de code : 5 par minute et par adresse IP, puis 429 GATEWAY_RATE_LIMITED et Retry-After', async () => {
    const http = request(app.getHttpServer());
    const send = (ip: string) =>
      http.post(OTP).set('Origin', ORIGINS.web).set('X-Forwarded-For', ip).send({ phone: '+2290197000045' });
    for (let i = 0; i < 5; i += 1) await send('198.51.100.1').expect(200);
    const limited = await send('198.51.100.1');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('GATEWAY_RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(identity.stub.calls.filter((call) => call.method === 'requestOtp')).toHaveLength(5);
    await send('198.51.100.2').expect(200);
  });

  it('routes connectÃ©es : compteur par utilisateur, quelle que soit lâ€™adresse IP', async () => {
    const http = request(app.getHttpServer());
    const token = await keys.accessToken();
    const get = (ip: string) =>
      http.get(ME).set('Authorization', `Bearer ${token}`).set('X-Forwarded-For', ip);
    await get('198.51.100.10').expect(200);
    await get('198.51.100.11').expect(200);
    const limited = await get('198.51.100.12');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('GATEWAY_RATE_LIMITED');
  });
});

describe('gateway : mode dÃ©gradÃ© (UC-GW-07)', () => {
  let keys: TestKeys;

  beforeAll(async () => {
    keys = await TestKeys.create();
  });

  it('identity injoignable : 503 IDENTITY_UNAVAILABLE, sans dÃ©tail technique', async () => {
    const app = await startGateway({ identityUrl: `127.0.0.1:${await freePort()}`, keys });
    try {
      const res = await request(app.getHttpServer())
        .get(ME)
        .set('Authorization', `Bearer ${await keys.accessToken()}`);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('IDENTITY_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|getMe|ECONNREFUSED/);
    } finally {
      await app.close();
    }
  });

  it('identity trop lent : 504 IDENTITY_TIMEOUT aprÃ¨s le dÃ©lai, Ã©criture non rejouÃ©e', async () => {
    const identity = await startIdentityStub(keys);
    identity.stub.on('updateMe', () => new Promise((resolve) => setTimeout(() => resolve({}), 400)));
    const app = await startGateway({ identityUrl: identity.url, keys, env: { GRPC_DEADLINE_MS: '200' } });
    try {
      const res = await request(app.getHttpServer())
        .patch(ME)
        .set('Authorization', `Bearer ${await keys.accessToken()}`)
        .send({ firstName: 'Koffi' });
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('IDENTITY_TIMEOUT');
      expect(identity.stub.calls.filter((call) => call.method === 'updateMe')).toHaveLength(1);
    } finally {
      await app.close();
      await identity.close();
    }
  });

  it('clÃ©s publiques impossibles Ã  charger : 503 (pas de 401 Ã  tort) et sonde Â« prÃªt Â» en Ã©chec', async () => {
    const app = await startGateway({
      identityUrl: `127.0.0.1:${await freePort()}`,
      keys,
      jwks: {
        fetch: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
    });
    try {
      const http = request(app.getHttpServer());
      const res = await http.get(ME).set('Authorization', `Bearer ${await keys.accessToken()}`);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('IDENTITY_UNAVAILABLE');
      const ready = await http.get('/health/ready');
      expect(ready.status).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('gateway : double authentification du back-office (UC-ID-09)', () => {
  const ENROLL = '/api/v1/identity/mfa/totp/enroll';
  const CONFIRM = '/api/v1/identity/mfa/totp/confirm';
  const MFA_VERIFY = '/api/v1/identity/mfa/verify';
  let keys: TestKeys;
  let identity: IdentityServer;
  let app: NestExpressApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    keys = await TestKeys.create();
    identity = await startIdentityStub(keys);
    app = await startGateway({ identityUrl: identity.url, keys });
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
    await identity?.close();
  });

  beforeEach(() => identity.stub.reset());

  const backoffice = (req: request.Test) =>
    req.set('Origin', ORIGINS.backoffice).set('X-Forwarded-For', nextIp()).set('User-Agent', 'Firefox');

  it('configuration : jeton et type de client (déduit de l’origine) transmis à identity', async () => {
    const res = await backoffice(http.post(ENROLL)).send({ mfaToken: 'mfa-1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ issuer: 'KSP', digits: 6, periodSeconds: 30 });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(identity.stub.last('enrollTotp')?.request).toEqual({
      mfaToken: 'mfa-1',
      clientKind: identityV1.ClientKind.CLIENT_KIND_BACKOFFICE,
    });
  });

  it('confirmation : codes de récupération et cookie __Secure-ksp_admin_rt, jamais le jeton dans le corps', async () => {
    const res = await backoffice(http.post(CONFIRM)).send({ mfaToken: 'mfa-1', code: '287082' });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(res.body.refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^__Secure-ksp_admin_rt=rt-admin; /);
    expect(cookie).toMatch(/Path=\/api\/v1\/identity\/token/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('seconde étape : méthode, code, adresse IP et appareil transmis ; session dans le cookie', async () => {
    const res = await backoffice(http.post(MFA_VERIFY)).send({
      mfaToken: 'mfa-1',
      method: 'recovery_code',
      code: '7KQ2M-X9PDA',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'authenticated', recoveryCodesRemaining: 9 });
    expect(String(res.headers['set-cookie'])).toMatch(/^__Secure-ksp_admin_rt=rt-admin; /);
    const call = identity.stub.last('verifyMfa');
    expect(call?.request).toEqual({
      mfaToken: 'mfa-1',
      method: identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE,
      code: '7KQ2M-X9PDA',
      clientKind: identityV1.ClientKind.CLIENT_KIND_BACKOFFICE,
    });
    expect(call?.context?.client).toMatchObject({ userAgent: 'Firefox' });
  });

  it('client inconnu refusé avant identity ; champ inconnu refusé', async () => {
    const unknown = await http.post(MFA_VERIFY).set('X-Forwarded-For', nextIp()).send({
      mfaToken: 'mfa-1',
      method: 'totp',
      code: '081804',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('GATEWAY_CLIENT_UNKNOWN');
    const extra = await backoffice(http.post(ENROLL)).send({ mfaToken: 'mfa-1', clientKind: 'backoffice' });
    expect(extra.status).toBe(400);
    expect(identity.stub.calls).toHaveLength(0);
  });

  it('erreur d’identity relayée telle quelle, sans cookie', async () => {
    identity.stub.on('verifyMfa', () =>
      Promise.reject(AppError.invalid('IDENTITY_MFA_CODE_REUSED', 'Déjà utilisé.', { attemptsRemaining: 3 })),
    );
    const res = await backoffice(http.post(MFA_VERIFY)).send({
      mfaToken: 'mfa-1',
      method: 'totp',
      code: '081804',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'IDENTITY_MFA_CODE_REUSED',
      details: { attemptsRemaining: 3 },
    });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('renouvellement refusé pour rôle retiré : cookie du back-office effacé', async () => {
    identity.stub.on('refreshSession', () =>
      Promise.reject(AppError.forbidden('IDENTITY_BACKOFFICE_FORBIDDEN', 'Accès refusé.')),
    );
    const res = await backoffice(http.post('/api/v1/identity/token/refresh')).set(
      'Cookie',
      '__Secure-ksp_admin_rt=rt-admin',
    );
    expect(res.status).toBe(403);
    expect(String(res.headers['set-cookie'])).toMatch(/^__Secure-ksp_admin_rt=; .*Max-Age=0/);
  });
});
