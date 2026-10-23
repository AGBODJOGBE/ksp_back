import { AppError } from '@ksp/platform';
import { InMemorySessionStore } from '../testing/fakes';
import { InMemoryRoles } from '../testing/mfa-fakes';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import { LogoutUseCase } from './logout.use-case';
import { RefreshSessionUseCase } from './refresh-session.use-case';
import { type Account } from './session.ports';

const DAY = 24 * 3600 * 1000;
const MINUTE = 60 * 1000;

function setup() {
  let now = new Date('2026-10-19T12:00:00Z');
  let seq = 0;
  const store = new InMemorySessionStore();
  const account: Account = {
    id: 'u-1',
    status: 'active',
    firstName: 'Koffi',
    lastName: 'Adjovi',
    phoneE164: '+2290197000045',
    email: null,
    preferredLanguage: 'fr',
    createdAt: now,
  };
  store.accounts.set(account.id, account);
  store.sessions.push(
    {
      id: 's-1',
      userId: 'u-1',
      clientKind: 'web',
      createdAt: new Date('2026-10-01T08:00:00Z'),
      lastSeenAt: new Date('2026-10-18T08:00:00Z'),
      expiresAt: new Date(now.getTime() + 10 * DAY),
      revokedAt: null,
    },
    {
      id: 's-2',
      userId: 'u-1',
      clientKind: 'mobile',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 30 * DAY),
      revokedAt: null,
    },
  );
  store.tokens.push({ id: 't-1', hash: 'h(rt-1)', sessionId: 's-1', usedAt: null });
  const roles = new InMemoryRoles();

  type Subject = {
    authTime: Date;
    clientId: string;
    sessionId: string;
    roles: unknown;
    mfa: boolean;
    amr: string[];
  };
  const issued: Subject[] = [];
  const accessTokens = {
    issue: async (subject: Subject) => {
      issued.push(subject);
      return { token: 'jwt', tokenId: 'j', expiresAt: new Date(now.getTime() + 900_000) };
    },
  } as unknown as AccessTokenIssuer;
  const refresh = new RefreshSessionUseCase(
    store,
    { generate: () => ({ token: `rt-${++seq + 1}`, hash: `h(rt-${seq + 1})` }) },
    (token) => `h(${token})`,
    accessTokens,
    { next: () => `t-${++seq + 100}` },
    { now: () => now },
    {
      customer: { refreshTtlSeconds: 30 * 24 * 3600, maxSessions: 5 },
      backoffice: {
        refreshTtlSeconds: 12 * 3600,
        maxSessions: 2,
        slidingExpiry: false,
        idleTimeoutSeconds: 1800,
      },
    },
    roles,
  );
  const logout = new LogoutUseCase(store, { now: () => now });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  /** Session back-office ouverte maintenant après la double authentification, jeton rt-bo. */
  const backofficeSession = () => {
    store.sessions.push({
      id: 's-bo',
      userId: 'u-1',
      clientKind: 'backoffice',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 12 * 3600 * 1000),
      revokedAt: null,
      mfaAt: now,
    });
    store.tokens.push({ id: 't-bo', hash: 'h(rt-bo)', sessionId: 's-bo', usedAt: null });
  };
  return { refresh, logout, store, account, roles, issued, advance, backofficeSession };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('RefreshSessionUseCase (UC-ID-04)', () => {
  it('remplace le jeton, prolonge la session de 30 jours et émet un jeton d’accès', async () => {
    const { refresh, store, issued } = setup();
    const renewed = await refresh.execute('rt-1');

    expect(renewed.refreshToken).not.toBe('rt-1');
    expect(renewed.sessionId).toBe('s-1');
    expect(renewed.refreshTokenExpiresAt).toEqual(new Date('2026-11-18T12:00:00Z'));
    expect(store.tokens.find((token) => token.id === 't-1')).toMatchObject({ usedAt: expect.any(Date) });
    expect(store.sessions[0].expiresAt).toEqual(new Date('2026-11-18T12:00:00Z'));
    expect(issued).toEqual([
      expect.objectContaining({
        sessionId: 's-1',
        clientId: 'web',
        // L'heure d'authentification reste celle de la connexion.
        authTime: new Date('2026-10-01T08:00:00Z'),
      }),
    ]);
  });

  it('le nouveau jeton sert au renouvellement suivant', async () => {
    const { refresh } = setup();
    const first = await refresh.execute('rt-1');
    await expect(refresh.execute(first.refreshToken)).resolves.toMatchObject({ sessionId: 's-1' });
  });

  it('un ancien jeton réutilisé révoque toute la session (vol), sans toucher aux autres', async () => {
    const { refresh, store } = setup();
    const renewed = await refresh.execute('rt-1');
    await expectAppError(refresh.execute('rt-1'), 'IDENTITY_REFRESH_TOKEN_REUSED');

    expect(store.sessions[0]).toMatchObject({ revokeReason: 'refresh_token_reused' });
    expect(store.sessions[1].revokedAt).toBeNull();
    await expectAppError(refresh.execute(renewed.refreshToken), 'IDENTITY_SESSION_REVOKED');
  });

  it('deux renouvellements simultanés avec le même jeton : le second révoque la session', async () => {
    const { refresh, store } = setup();
    store.raceOnNextRotation = true;
    await expectAppError(refresh.execute('rt-1'), 'IDENTITY_REFRESH_TOKEN_REUSED');
    expect(store.sessions[0]).toMatchObject({ revokeReason: 'refresh_token_reused' });
  });

  it('refuse un jeton inconnu ou vide', async () => {
    const { refresh } = setup();
    await expectAppError(refresh.execute('inconnu'), 'IDENTITY_REFRESH_TOKEN_INVALID');
    await expectAppError(refresh.execute(''), 'IDENTITY_REFRESH_TOKEN_INVALID');
  });

  it('refuse une session expirée', async () => {
    const { refresh, advance } = setup();
    advance(11 * DAY);
    await expectAppError(refresh.execute('rt-1'), 'IDENTITY_REFRESH_TOKEN_INVALID');
  });

  it('un compte suspendu ne peut plus renouveler sa session', async () => {
    const { refresh, account } = setup();
    account.status = 'suspended';
    await expectAppError(refresh.execute('rt-1'), 'IDENTITY_ACCOUNT_SUSPENDED');
  });
});

describe('LogoutUseCase (UC-ID-05)', () => {
  it('« cet appareil » révoque seulement la session courante', async () => {
    const { logout, store, refresh } = setup();
    await expect(logout.execute({ userId: 'u-1', sessionId: 's-1', scope: 'this_device' })).resolves.toBe(1);
    expect(store.sessions.map((session) => session.revokeReason)).toEqual(['logout', undefined]);
    await expectAppError(refresh.execute('rt-1'), 'IDENTITY_SESSION_REVOKED');
  });

  it('« tous les appareils » révoque toutes les sessions', async () => {
    const { logout, store } = setup();
    await expect(logout.execute({ userId: 'u-1', sessionId: 's-1', scope: 'all_devices' })).resolves.toBe(2);
    expect(store.sessions.every((session) => session.revokeReason === 'logout_all_devices')).toBe(true);
  });

  it('rejouer une déconnexion ne fait rien de plus', async () => {
    const { logout } = setup();
    await logout.execute({ userId: 'u-1', sessionId: 's-1', scope: 'this_device' });
    await expect(logout.execute({ userId: 'u-1', sessionId: 's-1', scope: 'this_device' })).resolves.toBe(0);
  });

  it('ne révoque jamais la session d’un autre utilisateur', async () => {
    const { logout, store } = setup();
    await expect(logout.execute({ userId: 'u-2', sessionId: 's-1', scope: 'this_device' })).resolves.toBe(0);
    expect(store.sessions[0].revokedAt).toBeNull();
  });
});

describe('RefreshSessionUseCase (sessions du back-office)', () => {
  it('sites et applications : rôle client, sans double authentification', async () => {
    const { refresh, issued } = setup();
    await refresh.execute('rt-1');
    expect(issued[0]).toMatchObject({
      roles: [{ role: 'customer', scopeType: 'personal' }],
      mfa: false,
      amr: ['otp'],
    });
  });

  it('échéance fixe de 12 heures, rôles relus, mfa et auth_time de la double authentification', async () => {
    const { refresh, roles, issued, advance, backofficeSession } = setup();
    backofficeSession();
    const openedAt = new Date('2026-10-19T12:00:00Z');
    roles.assign('u-1', 'cleaning_supervisor');
    advance(20 * MINUTE);
    const renewed = await refresh.execute('rt-bo');

    expect(renewed.refreshTokenExpiresAt).toEqual(new Date(openedAt.getTime() + 12 * 3600 * 1000));
    expect(issued[0]).toMatchObject({
      clientId: 'backoffice',
      mfa: true,
      authTime: openedAt,
      amr: ['otp', 'mfa'],
      roles: [
        { role: 'customer', scopeType: 'personal' },
        { role: 'cleaning_supervisor', scopeType: 'domain', scopeId: 'cleaning' },
      ],
    });
  });

  it('après 30 minutes sans renouvellement, la session est fermée', async () => {
    const { refresh, roles, store, advance, backofficeSession } = setup();
    backofficeSession();
    roles.assign('u-1', 'super_admin');
    advance(31 * MINUTE);
    await expectAppError(refresh.execute('rt-bo'), 'IDENTITY_REFRESH_TOKEN_INVALID');
    expect(store.sessions.find((session) => session.id === 's-bo')).toMatchObject({
      revokeReason: 'idle_timeout',
    });
  });

  it('un rôle retiré prend effet au renouvellement : session fermée', async () => {
    const { refresh, store, backofficeSession } = setup();
    backofficeSession();
    await expectAppError(refresh.execute('rt-bo'), 'IDENTITY_BACKOFFICE_FORBIDDEN');
    expect(store.sessions.find((session) => session.id === 's-bo')).toMatchObject({
      revokeReason: 'backoffice_access_removed',
    });
  });
});
