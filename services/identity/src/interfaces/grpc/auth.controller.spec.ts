import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import { type RequestOtpInput, type RequestOtpUseCase } from '../../application/otp/request-otp.use-case';
import {
  type OpenedSession,
  type VerifyOtpInput,
  type VerifyOtpUseCase,
} from '../../application/session/verify-otp.use-case';
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
    preferredLanguage: 'fr',
    createdAt: new Date('2026-10-19T12:00:00Z'),
  },
  profileIncomplete: true,
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
      return opened;
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
  return { requests, verifications, key, auth: new AuthGrpcController(requestOtp, verifyOtp, signingKeys) };
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
          },
          profileIncomplete: true,
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
