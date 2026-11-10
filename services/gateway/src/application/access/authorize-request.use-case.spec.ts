import { AppError } from '@ksp/platform';
import { DEFAULT_RATE_LIMITS } from '../../domain/rate-limit/rate-limits';
import { findRoute, type RouteDefinition } from '../../domain/routing/route-manifest';
import { CountingRateLimiter, FakeTokenVerifier, verifiedToken } from '../testing/fakes';
import { AuthorizeRequestUseCase } from './authorize-request.use-case';

const origins = { web: ['https://ksp.bj'], backoffice: ['https://admin.ksp.bj'] };
const route = (operationId: string) => findRoute(operationId) as RouteDefinition;

function setup() {
  const verifier = new FakeTokenVerifier();
  verifier.tokens.set('good', verifiedToken());
  const limiter = new CountingRateLimiter();
  const now = new Date('2026-10-20T10:00:00Z');
  const authorize = new AuthorizeRequestUseCase(verifier, limiter, origins, DEFAULT_RATE_LIMITS, {
    now: () => now,
  });
  return { authorize, verifier, limiter, now };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('AuthorizeRequestUseCase', () => {
  it('route publique d’authentification : type de client déduit de l’origine', async () => {
    const { authorize } = setup();
    await expect(
      authorize.execute(route('requestOtp'), { ip: '1.2.3.4', origin: 'https://ksp.bj' }),
    ).resolves.toEqual({ clientKind: 'web', caller: null });
    await expect(
      authorize.execute(route('requestOtp'), { ip: '1.2.3.4', appVersion: '1.0.0' }),
    ).resolves.toMatchObject({ clientKind: 'mobile' });
  });

  it('client inconnu sur une route d’authentification : GATEWAY_CLIENT_UNKNOWN', async () => {
    const { authorize } = setup();
    const error = await rejection(authorize.execute(route('verifyOtp'), { ip: '1.2.3.4' }));
    expect(error).toMatchObject({ kind: 'INVALID_ARGUMENT', code: 'GATEWAY_CLIENT_UNKNOWN' });
  });

  it('client inconnu accepté sur une route qui n’en dépend pas', async () => {
    const { authorize } = setup();
    await expect(authorize.execute(route('getJwks'), { ip: '1.2.3.4' })).resolves.toEqual({
      clientKind: null,
      caller: null,
    });
  });

  it('route connectée : jeton absent, mal formé ou invalide → 401', async () => {
    const { authorize } = setup();
    for (const authorization of [undefined, 'good', 'Basic good', 'Bearer ']) {
      const error = await rejection(authorize.execute(route('getMe'), { ip: '1.2.3.4', authorization }));
      expect(error).toMatchObject({ kind: 'UNAUTHENTICATED', code: 'GATEWAY_TOKEN_MISSING' });
    }
    const error = await rejection(
      authorize.execute(route('getMe'), { ip: '1.2.3.4', authorization: 'Bearer forged' }),
    );
    expect(error.code).toBe('GATEWAY_TOKEN_INVALID');
  });

  it('route connectée : jeton valide → appelant transmis', async () => {
    const { authorize } = setup();
    const result = await authorize.execute(route('getMe'), { ip: '1.2.3.4', authorization: 'Bearer good' });
    expect(result.caller?.user.userId).toBe('u-1');
  });

  it('exigence non remplie → 403 (rôle, double authentification)', async () => {
    const { authorize, verifier } = setup();
    const admin: RouteDefinition = {
      ...route('getMe'),
      access: { level: 'authenticated', anyRole: ['super_admin'] },
    };
    expect(
      await rejection(authorize.execute(admin, { ip: '1.2.3.4', authorization: 'Bearer good' })),
    ).toMatchObject({ kind: 'PERMISSION_DENIED', code: 'GATEWAY_FORBIDDEN' });

    verifier.tokens.set('admin', verifiedToken({ roles: [{ role: 'super_admin', scopeType: 'global' }] }));
    const mfa: RouteDefinition = { ...admin, access: { ...admin.access, recentMfaSeconds: 600 } };
    expect(
      await rejection(authorize.execute(mfa, { ip: '1.2.3.4', authorization: 'Bearer admin' })),
    ).toMatchObject({ kind: 'PERMISSION_DENIED', code: 'GATEWAY_MFA_REQUIRED' });
  });

  it('demande de code : 5 par minute et par adresse IP, puis 429 avec le délai', async () => {
    const { authorize } = setup();
    const request = { ip: '1.2.3.4', origin: 'https://ksp.bj' };
    for (let i = 0; i < 5; i += 1) await authorize.execute(route('requestOtp'), request);
    const error = await rejection(authorize.execute(route('requestOtp'), request));
    expect(error).toMatchObject({
      kind: 'RESOURCE_EXHAUSTED',
      code: 'GATEWAY_RATE_LIMITED',
      details: { retryAfterSeconds: 60 },
    });
    // Autre adresse IP, autre compteur.
    await expect(
      authorize.execute(route('requestOtp'), { ...request, ip: '5.6.7.8' }),
    ).resolves.toBeDefined();
  });

  it('la limite par IP s’applique même à une requête refusée ensuite', async () => {
    const { authorize, limiter } = setup();
    await rejection(authorize.execute(route('verifyOtp'), { ip: '1.2.3.4' }));
    expect(limiter.counts.get('otp_verify:ip:1.2.3.4')).toBe(1);
  });

  it('route connectée : compteur par utilisateur, après vérification du jeton', async () => {
    const { authorize, limiter } = setup();
    await authorize.execute(route('getMe'), { ip: '1.2.3.4', authorization: 'Bearer good' });
    await authorize.execute(route('updateMe'), { ip: '5.6.7.8', authorization: 'Bearer good' });
    expect(limiter.counts.get('authenticated:user:u-1')).toBe(2);
    await rejection(authorize.execute(route('getMe'), { ip: '1.2.3.4', authorization: 'Bearer forged' }));
    expect(limiter.counts.get('authenticated:user:u-1')).toBe(2);
  });

  it('route connectée : limite par adresse IP avant la vérification du jeton', async () => {
    const { authorize, limiter, verifier } = setup();
    const verify = jest.spyOn(verifier, 'verify');
    await rejection(authorize.execute(route('getMe'), { ip: '1.2.3.4', authorization: 'Bearer forged' }));
    expect(limiter.counts.get('authenticated_ip:ip:1.2.3.4')).toBe(1);
    // Rafale de jetons forgés depuis une adresse : refusée avant toute vérification de signature.
    const limited = new AuthorizeRequestUseCase(
      verifier,
      limiter,
      origins,
      DEFAULT_RATE_LIMITS,
      { now: () => new Date() },
      { limit: 1, windowSeconds: 60 },
    );
    verify.mockClear();
    const error = await rejection(
      limited.execute(route('getMe'), { ip: '1.2.3.4', authorization: 'Bearer forged' }),
    );
    expect(error).toMatchObject({ kind: 'RESOURCE_EXHAUSTED', code: 'GATEWAY_RATE_LIMITED' });
    expect(verify).not.toHaveBeenCalled();
  });

  describe('clé d’idempotence d’après le manifeste', () => {
    const required: RouteDefinition = { ...route('getMe'), idempotencyKey: 'required' };
    const optional: RouteDefinition = { ...route('getMe'), idempotencyKey: 'optional' };
    const caller = { ip: '1.2.3.4', authorization: 'Bearer good' };

    it('obligatoire : absente ou mal formée → 400 GATEWAY_VALIDATION_FAILED', async () => {
      const { authorize } = setup();
      for (const [idempotencyKey, reason] of [
        [undefined, 'invalid_type'],
        ['court', 'invalid_format'],
        ['espace interdite', 'invalid_format'],
      ] as const) {
        const error = await rejection(authorize.execute(required, { ...caller, idempotencyKey }));
        expect(error).toMatchObject({
          kind: 'INVALID_ARGUMENT',
          code: 'GATEWAY_VALIDATION_FAILED',
          details: { fields: [{ field: 'Idempotency-Key', reason }] },
        });
      }
      await expect(
        authorize.execute(required, { ...caller, idempotencyKey: 'commande-0001' }),
      ).resolves.toBeDefined();
    });

    it('facultative : absente acceptée, mal formée refusée', async () => {
      const { authorize } = setup();
      await expect(authorize.execute(optional, caller)).resolves.toBeDefined();
      const error = await rejection(authorize.execute(optional, { ...caller, idempotencyKey: 'court' }));
      expect(error.code).toBe('GATEWAY_VALIDATION_FAILED');
    });

    it('jeton vérifié avant la clé : 401 plutôt que 400', async () => {
      const { authorize } = setup();
      const error = await rejection(authorize.execute(required, { ip: '1.2.3.4' }));
      expect(error.kind).toBe('UNAUTHENTICATED');
    });
  });
});
