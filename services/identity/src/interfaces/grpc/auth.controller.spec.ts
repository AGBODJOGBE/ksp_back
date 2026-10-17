import { identityV1 } from '@ksp/contracts';
import { runWithContext } from '@ksp/platform';
import { type RequestOtpInput, type RequestOtpUseCase } from '../../application/otp/request-otp.use-case';
import { AuthGrpcController } from './auth.controller';

function controller() {
  const calls: RequestOtpInput[] = [];
  const useCase = {
    execute: async (input: RequestOtpInput) => {
      calls.push(input);
      return {
        challengeId: 'c-1',
        maskedTarget: '+229********45',
        channel: 'whatsapp' as const,
        expiresInSeconds: 300,
        resendAfterSeconds: 60,
      };
    },
  } as unknown as RequestOtpUseCase;
  return { calls, auth: new AuthGrpcController(useCase) };
}

const request = (overrides: Partial<identityV1.RequestOtpRequest> = {}): identityV1.RequestOtpRequest => ({
  phoneE164: '+2290197000045',
  channel: identityV1.OtpChannel.OTP_CHANNEL_UNSPECIFIED,
  purpose: identityV1.OtpPurpose.OTP_PURPOSE_LOGIN,
  ...overrides,
});

describe('AuthGrpcController.requestOtp', () => {
  it('utilise le SMS par défaut et lit l’adresse IP transmise par la gateway', async () => {
    const { calls, auth } = controller();
    const response = await runWithContext({ correlationId: 'corr-1', client: { ip: '196.192.10.4' } }, () =>
      auth.requestOtp(request()),
    );
    expect(calls).toEqual([
      { phone: '+2290197000045', channel: 'sms', purpose: 'login', ip: '196.192.10.4' },
    ]);
    expect(response).toEqual({
      challengeId: 'c-1',
      maskedTarget: '+229********45',
      channel: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP,
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    });
  });

  it('transmet le canal WhatsApp demandé', async () => {
    const { calls, auth } = controller();
    await auth.requestOtp(request({ channel: identityV1.OtpChannel.OTP_CHANNEL_WHATSAPP }));
    expect(calls[0]).toMatchObject({ channel: 'whatsapp', ip: null });
  });

  it('refuse un objet de code autre que la connexion', async () => {
    const { calls, auth } = controller();
    await expect(
      auth.requestOtp(request({ purpose: identityV1.OtpPurpose.OTP_PURPOSE_UNSPECIFIED })),
    ).rejects.toMatchObject({ code: 'IDENTITY_OTP_PURPOSE_INVALID' });
    expect(calls).toHaveLength(0);
  });
});
