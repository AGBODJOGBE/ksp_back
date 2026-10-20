import { type Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { identityV1 } from '@ksp/contracts';
import { AppError, GrpcCaller, runWithContext, toGrpcErrorPayload } from '@ksp/platform';
import { NEVER, type Observable, of, throwError } from 'rxjs';
import { IdentityGrpcAdapter } from './identity-grpc.adapter';
import { toUpstreamError } from './upstream-error';

const protoUser: identityV1.User = {
  id: 'u-1',
  status: identityV1.UserStatus.USER_STATUS_ACTIVE,
  firstName: '',
  lastName: 'Adjovi',
  phoneE164: '+2290197000045',
  email: '',
  preferredLanguage: 'fr',
  createdAt: '2026-10-17T10:00:00.000Z',
};

const protoSession: identityV1.SessionTokens = {
  accessToken: 'jwt',
  accessTokenExpiresAt: '2026-10-17T10:15:00.000Z',
  refreshToken: 'rt',
  refreshTokenExpiresAt: '2026-11-16T10:00:00.000Z',
  sessionId: 's-1',
  user: protoUser,
  profileIncomplete: true,
};

type Calls = { method: string; request: unknown; metadata: Metadata }[];

function setup(overrides: Partial<Record<string, (request: unknown) => Observable<unknown>>> = {}) {
  const calls: Calls = [];
  const handler =
    (method: string, fallback: (request: never) => Observable<unknown>) =>
    (request: unknown, metadata: Metadata) => {
      calls.push({ method, request, metadata });
      return (overrides[method] ?? fallback)(request as never);
    };
  const auth = {
    requestOtp: handler('requestOtp', () =>
      of({
        challengeId: 'c-1',
        maskedTarget: '+229********45',
        channel: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
        expiresInSeconds: 300,
        resendAfterSeconds: 60,
      }),
    ),
    verifyOtp: handler('verifyOtp', () => of({ result: { session: protoSession }, isNewUser: true })),
    refreshSession: handler('refreshSession', () => of({ session: protoSession })),
    logout: handler('logout', () => of({ revokedSessions: 2 })),
    getSigningKeys: handler('getSigningKeys', () => of({ keys: [] })),
  } as unknown as identityV1.AuthServiceClient;
  const account = {
    getMe: handler('getMe', () => of({ user: protoUser, profileIncomplete: false })),
    updateMe: handler('updateMe', () => of({ user: protoUser, profileIncomplete: false })),
  } as unknown as identityV1.AccountServiceClient;
  const adapter = new IdentityGrpcAdapter(
    auth,
    account,
    new GrpcCaller({ target: 'identity', defaultDeadlineMs: 50, retryBackoffMs: 1 }),
  );
  return { adapter, calls };
}

describe('IdentityGrpcAdapter', () => {
  it('demande de code : traduit le canal et fixe l’objet « connexion »', async () => {
    const { adapter, calls } = setup();
    await expect(adapter.requestOtp({ phone: '+2290197000045', channel: null })).resolves.toEqual({
      challengeId: 'c-1',
      maskedTarget: '+229********45',
      channel: 'whatsapp',
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    });
    await adapter.requestOtp({ phone: '+2290197000045', channel: 'sms' });
    expect(calls.map((call) => call.request)).toEqual([
      {
        phoneE164: '+2290197000045',
        channel: identityV1.OtpChannel.OTP_CHANNEL_UNSPECIFIED,
        purpose: identityV1.OtpPurpose.OTP_PURPOSE_LOGIN,
      },
      {
        phoneE164: '+2290197000045',
        channel: identityV1.OtpChannel.OTP_CHANNEL_SMS,
        purpose: identityV1.OtpPurpose.OTP_PURPOSE_LOGIN,
      },
    ]);
  });

  it('transmet le contexte de la requête dans les métadonnées', async () => {
    const { adapter, calls } = setup();
    await runWithContext(
      {
        correlationId: 'corr-1',
        client: { ip: '1.2.3.4', userAgent: 'Mozilla/5.0' },
        user: {
          userId: 'u-1',
          sessionId: 's-1',
          activeContext: 'personal',
          roles: [{ role: 'customer', scopeType: 'personal', scopeId: null }],
          mfa: false,
        },
      },
      () => adapter.logout('all_devices'),
    );
    const metadata = calls[0]!.metadata;
    expect(metadata.get('x-correlation-id')).toEqual(['corr-1']);
    expect(metadata.get('x-client-ip')).toEqual(['1.2.3.4']);
    expect(metadata.get('x-user-agent')).toEqual(['Mozilla/5.0']);
    expect(metadata.get('x-user-id')).toEqual(['u-1']);
    expect(metadata.get('x-session-id')).toEqual(['s-1']);
    expect(calls[0]!.request).toEqual({ scope: identityV1.LogoutScope.LOGOUT_SCOPE_ALL_DEVICES });
  });

  it('session : chaînes vides du protobuf → null, statut en clair', async () => {
    const { adapter, calls } = setup();
    const outcome = await adapter.verifyOtp({
      challengeId: 'c-1',
      code: '482913',
      clientKind: 'backoffice',
      deviceLabel: null,
    });
    expect(calls[0]!.request).toEqual({
      challengeId: 'c-1',
      code: '482913',
      clientKind: identityV1.ClientKind.CLIENT_KIND_BACKOFFICE,
      deviceLabel: '',
    });
    expect(outcome).toEqual({
      status: 'authenticated',
      isNewUser: true,
      session: {
        ...protoSession,
        user: {
          id: 'u-1',
          status: 'active',
          firstName: null,
          lastName: 'Adjovi',
          phone: '+2290197000045',
          email: null,
          preferredLanguage: 'fr',
          createdAt: '2026-10-17T10:00:00.000Z',
        },
      },
    });
  });

  it('double authentification demandée : méthodes en clair', async () => {
    const { adapter } = setup({
      verifyOtp: () =>
        of({
          result: {
            mfaRequired: {
              mfaToken: 'mfa',
              expiresAt: '2026-10-17T10:05:00.000Z',
              methods: [identityV1.MfaMethod.MFA_METHOD_TOTP, identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE],
              enrollmentRequired: true,
            },
          },
          isNewUser: false,
        }),
    });
    await expect(
      adapter.verifyOtp({ challengeId: 'c-1', code: '1', clientKind: 'backoffice', deviceLabel: null }),
    ).resolves.toEqual({
      status: 'mfa_required',
      challenge: {
        mfaToken: 'mfa',
        expiresAt: '2026-10-17T10:05:00.000Z',
        methods: ['totp', 'recovery_code'],
        enrollmentRequired: true,
      },
    });
  });

  it('modification du profil : seuls les champs fournis partent', async () => {
    const { adapter, calls } = setup();
    await adapter.updateMe({ firstName: 'Koffi' });
    expect(calls[0]!.request).toEqual({ firstName: 'Koffi' });
  });

  it('réponse hors contrat : erreur interne', async () => {
    const { adapter } = setup({ refreshSession: () => of({}) });
    await expect(adapter.refreshSession('rt')).rejects.toMatchObject({
      kind: 'INTERNAL',
      code: 'GATEWAY_UPSTREAM_ERROR',
    });
  });

  it('erreur métier d’identity : transmise telle quelle', async () => {
    const error = AppError.precondition('IDENTITY_OTP_EXPIRED', 'Le code a expiré.');
    const { adapter } = setup({ verifyOtp: () => throwError(() => toGrpcErrorPayload(error)) });
    await expect(
      adapter.verifyOtp({ challengeId: 'c-1', code: '1', clientKind: 'web', deviceLabel: null }),
    ).rejects.toMatchObject({ kind: 'FAILED_PRECONDITION', code: 'IDENTITY_OTP_EXPIRED' });
  });

  it('écriture : jamais rejouée ; lecture : une nouvelle tentative', async () => {
    const down = () => throwError(() => ({ code: GrpcStatus.UNAVAILABLE, details: 'No connection' }));
    const { adapter, calls } = setup({ logout: down, getMe: down });
    await expect(adapter.logout('this_device')).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
    expect(calls.filter((call) => call.method === 'logout')).toHaveLength(1);
    await expect(adapter.getMe()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' });
    expect(calls.filter((call) => call.method === 'getMe')).toHaveLength(2);
  });

  it('délai dépassé : IDENTITY_TIMEOUT, sans nom de méthode dans le message', async () => {
    const { adapter } = setup({ updateMe: () => NEVER });
    const error = (await adapter.updateMe({ firstName: 'Koffi' }).catch((e: unknown) => e)) as AppError;
    expect(error).toMatchObject({ kind: 'DEADLINE_EXCEEDED', code: 'IDENTITY_TIMEOUT' });
    expect(error.message).not.toContain('updateMe');
  });
});

describe('toUpstreamError', () => {
  it.each([
    [
      { code: GrpcStatus.UNAVAILABLE, details: 'No connection established' },
      'UNAVAILABLE',
      'IDENTITY_UNAVAILABLE',
    ],
    [{ code: GrpcStatus.CANCELLED, details: 'Cancelled' }, 'UNAVAILABLE', 'IDENTITY_UNAVAILABLE'],
    [{ code: GrpcStatus.UNIMPLEMENTED, details: 'Method not found' }, 'INTERNAL', 'GATEWAY_UPSTREAM_ERROR'],
    [
      new AppError('INTERNAL', 'SERVICE_TOKEN_REFUSED', 'identity refuse (invalid_client).'),
      'INTERNAL',
      'GATEWAY_UPSTREAM_ERROR',
    ],
    [
      AppError.unavailable('SERVICE_TOKEN_UNAVAILABLE', 'identity ne répond pas.'),
      'UNAVAILABLE',
      'IDENTITY_UNAVAILABLE',
    ],
  ])('panne technique %j → %s %s, message générique', (error, kind, code) => {
    const upstream = toUpstreamError('identity', error);
    expect(upstream).toMatchObject({ kind, code });
    expect(upstream.message).not.toMatch(/connection|Method|invalid_client|ne répond/);
  });

  it('erreur métier : inchangée', () => {
    const error = AppError.invalid('IDENTITY_OTP_INVALID', 'Le code est incorrect.', {
      attemptsRemaining: 3,
    });
    expect(toUpstreamError('identity', error)).toBe(error);
  });
});
