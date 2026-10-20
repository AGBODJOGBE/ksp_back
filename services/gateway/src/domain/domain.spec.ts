import { checkAccess } from './access/access-policy';
import { refreshTokenTransport, resolveClientKind } from './client/client-kind';
import { DEFAULT_RATE_LIMITS, rateLimitKey } from './rate-limit/rate-limits';
import { manifestProblems } from './routing/manifest-rules';
import { findRoute, ROUTE_MANIFEST, type RouteDefinition } from './routing/route-manifest';
import { refreshCookieMaxAge, refreshCookieName } from './session/refresh-cookie';

const route = (overrides: Partial<RouteDefinition> = {}): RouteDefinition => ({
  operationId: 'getThing',
  method: 'GET',
  path: '/api/v1/things/items',
  grpc: 'ksp.things.v1.ThingService/GetThing',
  access: { level: 'public' },
  rateLimit: 'public',
  requiresKnownClient: false,
  ...overrides,
});

describe('manifeste de routage', () => {
  it('le manifeste du lot 1 respecte toutes les règles', () => {
    expect(manifestProblems(ROUTE_MANIFEST, DEFAULT_RATE_LIMITS)).toEqual([]);
  });

  it('retrouve une route par son operationId', () => {
    expect(findRoute('getMe')).toMatchObject({ method: 'GET', path: '/api/v1/identity/me' });
    expect(findRoute('inconnue')).toBeUndefined();
  });

  it.each([
    ['un doublon d’operationId', [route(), route({ path: '/api/v1/things/other' })], 'operationId en double'],
    ['un doublon de route', [route(), route({ operationId: 'other' })], 'route en double'],
    ['un chemin hors préfixe', [route({ path: '/internal/things' })], 'hors des préfixes'],
    ['un préfixe réservé', [route({ path: '/api/v1/bff/web/home' })], 'préfixe réservé'],
    ['un appel gRPC mal formé', [route({ grpc: 'GetThing' })], 'appel gRPC mal formé'],
    [
      'une limite par utilisateur sur une route publique',
      [route({ rateLimit: 'authenticated' })],
      'limite par utilisateur',
    ],
    [
      'un rôle exigé sur une route publique',
      [route({ access: { level: 'public', anyRole: ['agent'] } })],
      'non connectée',
    ],
    [
      'une route du back-office sans double authentification',
      [
        route({
          path: '/api/v1/admin/recovery/cases',
          access: { level: 'authenticated', anyRole: ['recovery_agent'] },
          rateLimit: 'authenticated',
        }),
      ],
      'sans double authentification',
    ],
  ])('signale %s', (_label, routes, problem) => {
    expect(manifestProblems(routes, DEFAULT_RATE_LIMITS).join('\n')).toContain(problem);
  });

  it('accepte une route du back-office avec rôle et double authentification récente', () => {
    const admin = route({
      path: '/api/v1/admin/recovery/cases',
      access: { level: 'authenticated', anyRole: ['recovery_agent'], recentMfaSeconds: 600 },
      rateLimit: 'authenticated',
    });
    expect(manifestProblems([admin], DEFAULT_RATE_LIMITS)).toEqual([]);
  });
});

describe('exigences d’accès', () => {
  const now = 1_792_400_000;
  const caller = { roles: [{ role: 'customer' }], mfa: false };

  it('une route publique ou de renouvellement est ouverte à tous', () => {
    expect(checkAccess({ level: 'public' }, null, now)).toEqual({ allowed: true });
    expect(checkAccess({ level: 'refresh_token' }, null, now)).toEqual({ allowed: true });
  });

  it('une route connectée exige un appelant', () => {
    expect(checkAccess({ level: 'authenticated' }, null, now)).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
    expect(checkAccess({ level: 'authenticated' }, caller, now)).toEqual({ allowed: true });
  });

  it('un rôle manquant est refusé', () => {
    const requirement = { level: 'authenticated' as const, anyRole: ['recovery_agent', 'super_admin'] };
    expect(checkAccess(requirement, caller, now)).toEqual({ allowed: false, reason: 'role_missing' });
    expect(checkAccess(requirement, { ...caller, roles: [{ role: 'super_admin' }] }, now)).toEqual({
      allowed: true,
    });
  });

  it('la double authentification doit être récente', () => {
    const requirement = { level: 'authenticated' as const, recentMfaSeconds: 600 };
    expect(checkAccess(requirement, caller, now)).toMatchObject({ reason: 'mfa_required' });
    expect(checkAccess(requirement, { ...caller, mfa: true, authTime: now - 601 }, now)).toMatchObject({
      reason: 'mfa_required',
    });
    expect(checkAccess(requirement, { ...caller, mfa: true, authTime: now - 600 }, now)).toEqual({
      allowed: true,
    });
  });
});

describe('type de client', () => {
  const origins = { web: ['https://ksp.bj', 'https://shop.ksp.bj'], backoffice: ['https://admin.ksp.bj'] };

  it.each([
    [{ origin: 'https://ksp.bj' }, 'web'],
    [{ origin: 'https://shop.ksp.bj', appVersion: '1.0.0' }, 'web'],
    [{ origin: 'https://admin.ksp.bj' }, 'backoffice'],
    [{ appVersion: '1.4.2' }, 'mobile'],
    [{ origin: 'https://evil.example' }, null],
    [{ origin: 'https://evil.example', appVersion: '1.4.2' }, null],
    [{ appVersion: '  ' }, null],
    [{}, null],
  ])('%j → %s', (request, expected) => {
    expect(resolveClientKind(request, origins)).toBe(expected);
  });

  it('le jeton de renouvellement voyage en cookie dans un navigateur, dans le corps sur mobile', () => {
    expect(refreshTokenTransport('web')).toBe('cookie');
    expect(refreshTokenTransport('backoffice')).toBe('cookie');
    expect(refreshTokenTransport('mobile')).toBe('body');
  });
});

describe('limites d’appels', () => {
  it('compte par adresse IP ou par utilisateur, séparément pour chaque catégorie', () => {
    expect(rateLimitKey('otp_request', DEFAULT_RATE_LIMITS.otp_request, { ip: '1.2.3.4' })).toBe(
      'otp_request:ip:1.2.3.4',
    );
    expect(
      rateLimitKey('authenticated', DEFAULT_RATE_LIMITS.authenticated, { ip: '1.2.3.4', userId: 'u-1' }),
    ).toBe('authenticated:user:u-1');
    expect(rateLimitKey('authenticated', DEFAULT_RATE_LIMITS.authenticated, { ip: '1.2.3.4' })).toBeNull();
  });
});

describe('cookie de renouvellement', () => {
  it('porte le préfixe __Secure- quand il est sécurisé', () => {
    expect(refreshCookieName('web', true)).toBe('__Secure-ksp_rt');
    expect(refreshCookieName('backoffice', true)).toBe('__Secure-ksp_admin_rt');
    expect(refreshCookieName('web', false)).toBe('ksp_rt');
  });

  it('expire avec le jeton', () => {
    const now = new Date('2026-10-17T10:00:00Z');
    expect(refreshCookieMaxAge(new Date('2026-11-16T10:00:00Z'), now)).toBe(2_592_000);
    expect(refreshCookieMaxAge(new Date('2026-10-17T09:00:00Z'), now)).toBe(0);
  });
});
