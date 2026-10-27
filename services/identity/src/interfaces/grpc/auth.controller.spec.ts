import { type SwitchContextUseCase } from '../../application/session/switch-context.use-case';
import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import { type ConfirmTotpUseCase } from '../../application/mfa/confirm-totp.use-case';
import { type EnrollTotpUseCase } from '../../application/mfa/enroll-totp.use-case';
import { type VerifyMfaInput, type VerifyMfaUseCase } from '../../application/mfa/verify-mfa.use-case';
import { type RequestOtpInput, type RequestOtpUseCase } from '../../application/otp/request-otp.use-case';
import {
  type OpenedSession,
  type VerifyOtpInput,
  type VerifyOtpUseCase,
} from '../../application/session/verify-otp.use-case';
import { type LogoutUseCase } from '../../application/session/logout.use-case';
import { type RefreshSessionUseCase } from '../../application/session/refresh-session.use-case';
import { GetSigningKeysUseCase } from '../../application/token/get-signing-keys.use-case';
import { type PublicSigningKey } from '../../application/token/token.ports';
import { AuthGrpcController } from './auth.controller';

const opened: OpenedSession = {
  accessToken: 'jwt',
  accessTokenExpiresAt: new Date('2026-10-19T12:15:00Z'),
  refreshToken: 'rt',
  refreshTokenExpiresAt: new Date('2026-11-18T12:00:00Z'),
  sessionId: 's-1',
  account: {
    id: 'u-1',
    status: 'active',
    firstName: null,
    lastName: null,
    phoneE164: '+2290197000045',
    email: null,
    emailVerifiedAt: null,
    preferredLanguage: 'fr',
    createdAt: new Date('2026-10-19T12:00:00Z'),
  },
  profileIncomplete: true,
  activeContext: { type: 'individual', organizationId: null, organizationName: null },
  isNewUser: true,
};

function controller() {
  const requests: RequestOtpInput[] = [];
  const verifications: VerifyOtpInput[] = [];
  const requestOtp = {
    execute: async (input: RequestOtpInput) => {
      requests.push(input);
      return {
        challengeId: 'c-1',
        maskedTarget: '+229********45',
        channel: 'whatsapp' as const,
        expiresInSeconds: 300,
        resendAfterSeconds: 60,
      };
    },
  } as unknown as RequestOtpUseCase;
  const verifyOtp = {
    execute: async (input: VerifyOtpInput) => {
      verifications.push(input);
      if (input.clientKind === 'backoffice') {
        return {
          status: 'mfa_required',
          challenge: {
            mfaToken: 'mfa-1',
            expiresAt: new Date('2026-10-19T12:05:00Z'),
            methods: ['totp', 'recovery_code'],
            enrollmentRequired: false,
          },
        };
      }
      return { status: 'authenticated', session: opened };
    },
  } as unknown as VerifyOtpUseCase;
  const key: PublicSigningKey = {
    kid: 'k1',
    kty: 'EC',
    crv: 'P-256',
    x: 'x',
    y: 'y',
    alg: 'ES256',
    use: 'sig',
  };
  const signingKeys = new GetSigningKeysUseCase({ sign: async () => '', publicKeys: () => [key] });
  const refreshes: string[] = [];
  const refresh = {
    execute: async (token: string) => {
      refreshes.push(token);
      return { ...opened, isNewUser: undefined };
    },
  } as unknown as RefreshSessionUseCase;
  const logouts: { userId: string; sessionId: string; scope: string }[] = [];
  const logout = {
    execute: async (input: { userId: string; sessionId: string; scope: string }) => {
      logouts.push(input);
      return input.scope === 'all_devices' ? 3 : 1;
    },
  } as unknown as LogoutUseCase;
  const enroll = {
    execute: async (input: { mfaToken: string; clientKind: string }) => ({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/KSP:x',
      issuer: 'KSP',
      accountName: input.clientKind,
      digits: 6,
      periodSeconds: 30,
    }),
  } as unknown as EnrollTotpUseCase;
  const confirm = {
    execute: async () => ({
      session: { ...opened, recoveryCodesRemaining: 10 },
      recoveryCodes: ['7KQ2M-X9PDA'],
    }),
  } as unknown as ConfirmTotpUseCase;
  const switches: { userId: string; sessionId: string; organizationId: string | null }[] = [];
  const switchContext = {
    execute: async (input: { userId: string; sessionId: string; organizationId: string | null }) => {
      switches.push(input);
      return {
        accessToken: 'jwt-org',
        accessTokenExpiresAt: new Date('2026-10-27T10:15:00Z'),
        activeContext: input.organizationId
          ? { type: 'business', organizationId: input.organizationId, organizationName: 'SARL Bénin Propre' }
          : { type: 'individual', organizationId: null, organizationName: null },
      };
    },
  } as unknown as SwitchContextUseCase;
  const mfaVerifications: VerifyMfaInput[] = [];
  const verifyMfa = {
    execute: async (input: VerifyMfaInput) => {
      mfaVerifications.push(input);
      return { ...opened, recoveryCodesRemaining: 7 };
    },
  } as unknown as VerifyMfaUseCase;
  return {
    switches,
    requests,
    verifications,
    mfaVerifications,
    refreshes,
    logouts,
    key,
    auth: new AuthGrpcController(
      requestOtp,
      verifyOtp,
      refresh,
      logout,
      signingKeys,
      enroll,
      confirm,
      verifyMfa,
      switchContext,
    ),
  };
}

const otpRequest = (overrides: Partial<identityV1.RequestOtpRequest> = {}): identityV1.RequestOtpRequest => ({
  phoneE164: '+2290197000045',
  channel: identityV1.OtpChannel.OTP_CHANNEL_UNSPECIFIED,
  purpose: identityV1.OtpPurpose.OTP_PURPOSE_LOGIN,
  ...overrides,
});

describe('AuthGrpcController.requestOtp', () => {
  it('utilise WhatsApp par défaut (ADR-021) et lit l’adresse IP transmise par la gateway', async () => {
    const { requests, auth } = controller();
    const response = await runWithContext({ correlationId: 'corr-1', client: { ip: '196.192.10.4' } }, () =>
      auth.requestOtp(otpRequest()),
    );
    expect(requests).toEqual([
      { phone: '+2290197000045', channel: 'whatsapp', purpose: 'login', ip: '196.192.10.4' },
    ]);
    expect(response).toEqual({
      challengeId: 'c-1',
      maskedTarget: '+229********45',
      channel: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    });
  });

  it('transmet le canal SMS demandé', async () => {
    const { requests, auth } = controller();
    await auth.requestOtp(otpRequest({ channel: identityV1.OtpChannel.OTP_CHANNEL_SMS }));
    expect(requests[0]).toMatchObject({ channel: 'sms', ip: null });
  });

  it('refuse un objet de code autre que la connexion', async () => {
    const { requests, auth } = controller();
    await expect(
      auth.requestOtp(otpRequest({ purpose: identityV1.OtpPurpose.OTP_PURPOSE_UNSPECIFIED })),
    ).rejects.toMatchObject({ code: 'IDENTITY_OTP_PURPOSE_INVALID' });
    expect(requests).toHaveLength(0);
  });
});

describe('AuthGrpcController.verifyOtp', () => {
  const verifyRequest = (
    overrides: Partial<identityV1.VerifyOtpRequest> = {},
  ): identityV1.VerifyOtpRequest => ({
    challengeId: 'c-1',
    code: '482913',
    clientKind: identityV1.ClientKind.CLIENT_KIND_MOBILE,
    deviceLabel: '  Téléphone Android ',
    ...overrides,
  });

  it('transmet le client et l’appareil, puis renvoie la session au format du contrat', async () => {
    const { verifications, auth } = controller();
    const response = await runWithContext(
      { correlationId: 'corr-1', client: { ip: '196.192.10.4', userAgent: 'KSP/1.0 Android' } },
      () => auth.verifyOtp(verifyRequest()),
    );
    expect(verifications).toEqual([
      {
        challengeId: 'c-1',
        code: '482913',
        clientKind: 'mobile',
        deviceLabel: 'Téléphone Android',
        ip: '196.192.10.4',
        userAgent: 'KSP/1.0 Android',
      },
    ]);
    expect(response).toEqual({
      result: {
        session: {
          accessToken: 'jwt',
          accessTokenExpiresAt: '2026-10-19T12:15:00.000Z',
          refreshToken: 'rt',
          refreshTokenExpiresAt: '2026-11-18T12:00:00.000Z',
          sessionId: 's-1',
          user: {
            id: 'u-1',
            status: identityV1.UserStatus.USER_STATUS_ACTIVE,
            firstName: '',
            lastName: '',
            phoneE164: '+2290197000045',
            email: '',
            preferredLanguage: 'fr',
            createdAt: '2026-10-19T12:00:00.000Z',
            emailVerified: false,
          },
          profileIncomplete: true,
          activeContext: {
            type: identityV1.ContextType.CONTEXT_TYPE_INDIVIDUAL,
            organizationId: '',
            organizationName: '',
          },
        },
      },
      isNewUser: true,
    });
  });

  it('refuse un type de client non précisé', async () => {
    const { verifications, auth } = controller();
    await expect(
      auth.verifyOtp(verifyRequest({ clientKind: identityV1.ClientKind.CLIENT_KIND_UNSPECIFIED })),
    ).rejects.toMatchObject({ code: 'IDENTITY_CLIENT_KIND_INVALID' });
    expect(verifications).toHaveLength(0);
  });

  it('un nom d’appareil vide devient null', async () => {
    const { verifications, auth } = controller();
    await auth.verifyOtp(verifyRequest({ deviceLabel: '   ' }));
    expect(verifications[0].deviceLabel).toBeNull();
  });
});

describe('AuthGrpcController.getSigningKeys', () => {
  it('renvoie les clés publiques du signataire', () => {
    const { auth, key } = controller();
    expect(auth.getSigningKeys()).toEqual({ keys: [key] });
  });
});

describe('AuthGrpcController.refreshSession', () => {
  it('transmet le jeton de renouvellement et renvoie les nouveaux jetons', async () => {
    const { refreshes, auth } = controller();
    const response = await auth.refreshSession({ refreshToken: 'rt-ancien' });
    expect(refreshes).toEqual(['rt-ancien']);
    expect(response.session).toMatchObject({ accessToken: 'jwt', refreshToken: 'rt', sessionId: 's-1' });
  });
});

describe('AuthGrpcController.logout', () => {
  const user = {
    userId: 'u-1',
    sessionId: 's-1',
    activeContext: 'personal',
    roles: [],
    mfa: false,
  };

  it('déconnecte cet appareil par défaut, avec la session transmise par la gateway', async () => {
    const { logouts, auth } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () =>
      auth.logout({ scope: identityV1.LogoutScope.LOGOUT_SCOPE_UNSPECIFIED }),
    );
    expect(logouts).toEqual([{ userId: 'u-1', sessionId: 's-1', scope: 'this_device' }]);
    expect(response).toEqual({ revokedSessions: 1 });
  });

  it('déconnecte tous les appareils sur demande', async () => {
    const { logouts, auth } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () =>
      auth.logout({ scope: identityV1.LogoutScope.LOGOUT_SCOPE_ALL_DEVICES }),
    );
    expect(logouts[0].scope).toBe('all_devices');
    expect(response).toEqual({ revokedSessions: 3 });
  });

  it('refuse un appel sans utilisateur connecté', async () => {
    const { logouts, auth } = controller();
    await expect(
      auth.logout({ scope: identityV1.LogoutScope.LOGOUT_SCOPE_THIS_DEVICE }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(logouts).toHaveLength(0);
  });
});

describe('AuthGrpcController : double authentification (UC-ID-09)', () => {
  const backoffice = identityV1.ClientKind.CLIENT_KIND_BACKOFFICE;

  it('VerifyOtp au back-office renvoie l’étape de double authentification', async () => {
    const { auth } = controller();
    const response = await auth.verifyOtp({
      challengeId: 'c-1',
      code: '482913',
      clientKind: backoffice,
      deviceLabel: '',
    });
    expect(response).toEqual({
      result: {
        mfaRequired: {
          mfaToken: 'mfa-1',
          expiresAt: '2026-10-19T12:05:00.000Z',
          methods: [identityV1.MfaMethod.MFA_METHOD_TOTP, identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE],
          enrollmentRequired: false,
        },
      },
      isNewUser: false,
    });
  });

  it('EnrollTotp, ConfirmTotp : secret, puis session et codes de récupération', async () => {
    const { auth } = controller();
    await expect(auth.enrollTotp({ mfaToken: 'mfa-1', clientKind: backoffice })).resolves.toMatchObject({
      issuer: 'KSP',
      accountName: 'backoffice',
      digits: 6,
    });
    const confirmed = await auth.confirmTotp({ mfaToken: 'mfa-1', code: '287082', clientKind: backoffice });
    expect(confirmed.recoveryCodes).toEqual(['7KQ2M-X9PDA']);
    expect(confirmed.session).toMatchObject({ sessionId: 's-1', refreshToken: 'rt' });
  });

  it('VerifyMfa transmet la méthode et le client, et renvoie les codes restants', async () => {
    const { auth, mfaVerifications } = controller();
    const response = await runWithContext(
      { correlationId: 'c', client: { ip: '196.192.10.4', userAgent: 'Firefox' } },
      () =>
        auth.verifyMfa({
          mfaToken: 'mfa-1',
          method: identityV1.MfaMethod.MFA_METHOD_RECOVERY_CODE,
          code: '7KQ2M-X9PDA',
          clientKind: backoffice,
        }),
    );
    expect(response.recoveryCodesRemaining).toBe(7);
    expect(mfaVerifications).toEqual([
      {
        mfaToken: 'mfa-1',
        method: 'recovery_code',
        code: '7KQ2M-X9PDA',
        clientKind: 'backoffice',
        ip: '196.192.10.4',
        userAgent: 'Firefox',
      },
    ]);
  });

  it('VerifyMfa refuse le SMS et une méthode non précisée', async () => {
    const { auth } = controller();
    for (const method of [identityV1.MfaMethod.MFA_METHOD_SMS, identityV1.MfaMethod.MFA_METHOD_UNSPECIFIED]) {
      await expect(
        auth.verifyMfa({ mfaToken: 'mfa-1', method, code: '123456', clientKind: backoffice }),
      ).rejects.toMatchObject({ code: 'IDENTITY_MFA_METHOD_INVALID' });
    }
    await expect(
      auth.enrollTotp({ mfaToken: 'mfa-1', clientKind: identityV1.ClientKind.CLIENT_KIND_UNSPECIFIED }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CLIENT_KIND_INVALID' });
  });
});

describe('AuthGrpcController.switchContext (UC-ID-15)', () => {
  const user = {
    userId: 'u-1',
    sessionId: 's-1',
    activeContext: 'personal',
    roles: [],
    mfa: false,
  };
  const ORG = '0192f1c4-0000-7000-8000-0000000000a1';

  it('transmet l’utilisateur et la session du jeton, et rend le nouveau jeton au format du contrat', async () => {
    const { auth, switches } = controller();
    const response = await runWithContext({ correlationId: 'c', user }, () =>
      auth.switchContext({ organizationId: ORG }),
    );
    expect(switches).toEqual([{ userId: 'u-1', sessionId: 's-1', organizationId: ORG }]);
    expect(response).toEqual({
      accessToken: 'jwt-org',
      accessTokenExpiresAt: '2026-10-27T10:15:00.000Z',
      activeContext: {
        type: identityV1.ContextType.CONTEXT_TYPE_BUSINESS,
        organizationId: ORG,
        organizationName: 'SARL Bénin Propre',
      },
    });
  });

  it('organisation vide : retour au contexte personnel', async () => {
    const { auth, switches } = controller();
    await runWithContext({ correlationId: 'c', user }, () => auth.switchContext({ organizationId: ' ' }));
    expect(switches[0].organizationId).toBeNull();
  });
});
