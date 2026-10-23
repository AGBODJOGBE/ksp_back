import { FakeIdentity } from '../testing/fakes';
import { GetPublicKeysUseCase } from '../keys/public-keys';
import {
  ConfirmTotpUseCase,
  EnrollTotpUseCase,
  GetMeUseCase,
  LogoutUseCase,
  RefreshSessionUseCase,
  RequestOtpUseCase,
  UpdateMeUseCase,
  VerifyMfaUseCase,
  VerifyOtpUseCase,
} from './identity.use-cases';

describe('cas d’usage identity de la gateway', () => {
  it('demande de code : canal laissé au choix d’identity s’il n’est pas précisé', async () => {
    const identity = new FakeIdentity();
    await new RequestOtpUseCase(identity).execute({ phone: '+2290197000045' });
    await new RequestOtpUseCase(identity).execute({ phone: '+2290197000045', channel: 'sms' });
    expect(identity.calls.map((call) => call.input)).toEqual([
      { phone: '+2290197000045', channel: null },
      { phone: '+2290197000045', channel: 'sms' },
    ]);
  });

  it('validation du code : transmet le type de client, nom d’appareil vide → null', async () => {
    const identity = new FakeIdentity();
    const outcome = await new VerifyOtpUseCase(identity).execute({
      challengeId: 'c-1',
      code: '482913',
      deviceLabel: '   ',
      clientKind: 'web',
    });
    expect(outcome.status).toBe('authenticated');
    expect(identity.calls[0]?.input).toEqual({
      challengeId: 'c-1',
      code: '482913',
      clientKind: 'web',
      deviceLabel: null,
    });
  });

  describe('renouvellement', () => {
    it('navigateur : jeton lu dans le cookie', async () => {
      const identity = new FakeIdentity();
      await new RefreshSessionUseCase(identity).execute({ clientKind: 'web', cookieToken: 'rt-1' });
      await new RefreshSessionUseCase(identity).execute({ clientKind: 'backoffice', cookieToken: 'rt-a' });
      expect(identity.calls.map((call) => call.input)).toEqual(['rt-1', 'rt-a']);
    });

    it('navigateur : jeton dans le corps refusé, cookie absent → 401', async () => {
      const identity = new FakeIdentity();
      const useCase = new RefreshSessionUseCase(identity);
      await expect(
        useCase.execute({ clientKind: 'web', cookieToken: 'rt-1', bodyToken: 'rt-1' }),
      ).rejects.toMatchObject({ code: 'GATEWAY_VALIDATION_FAILED', kind: 'INVALID_ARGUMENT' });
      await expect(useCase.execute({ clientKind: 'web' })).rejects.toMatchObject({
        code: 'GATEWAY_TOKEN_MISSING',
        kind: 'UNAUTHENTICATED',
      });
      expect(identity.calls).toEqual([]);
    });

    it('mobile : jeton lu dans le corps, cookie ignoré', async () => {
      const identity = new FakeIdentity();
      const useCase = new RefreshSessionUseCase(identity);
      await useCase.execute({ clientKind: 'mobile', cookieToken: 'rt-c', bodyToken: 'rt-m' });
      expect(identity.calls[0]?.input).toBe('rt-m');
      await expect(useCase.execute({ clientKind: 'mobile', cookieToken: 'rt-c' })).rejects.toMatchObject({
        code: 'GATEWAY_TOKEN_MISSING',
      });
    });
  });

  it('double authentification : jeton, code et type de client transmis tels quels à identity', async () => {
    const identity = new FakeIdentity();
    const mfaToken = 'mfa-1';
    await new EnrollTotpUseCase(identity).execute({ mfaToken, clientKind: 'backoffice' });
    const confirmed = await new ConfirmTotpUseCase(identity).execute({
      mfaToken,
      code: '287082',
      clientKind: 'backoffice',
    });
    const verified = await new VerifyMfaUseCase(identity).execute({
      mfaToken,
      method: 'recovery_code',
      code: '7KQ2M-X9PDA',
      clientKind: 'backoffice',
    });
    expect(confirmed.recoveryCodes).toEqual(['7KQ2M-X9PDA']);
    expect(verified.recoveryCodesRemaining).toBe(10);
    expect(identity.calls).toEqual([
      { method: 'enrollTotp', input: { mfaToken, clientKind: 'backoffice' } },
      { method: 'confirmTotp', input: { mfaToken, code: '287082', clientKind: 'backoffice' } },
      {
        method: 'verifyMfa',
        input: { mfaToken, method: 'recovery_code', code: '7KQ2M-X9PDA', clientKind: 'backoffice' },
      },
    ]);
  });

  it('déconnexion : cet appareil par défaut', async () => {
    const identity = new FakeIdentity();
    await expect(new LogoutUseCase(identity).execute({})).resolves.toBe(1);
    await expect(new LogoutUseCase(identity).execute({ scope: 'all_devices' })).resolves.toBe(3);
    expect(identity.calls.map((call) => call.input)).toEqual(['this_device', 'all_devices']);
  });

  it('profil : lecture et modification', async () => {
    const identity = new FakeIdentity();
    await expect(new GetMeUseCase(identity).execute()).resolves.toMatchObject({ profileIncomplete: true });
    await expect(new UpdateMeUseCase(identity).execute({ firstName: 'Koffi' })).resolves.toMatchObject({
      user: { firstName: 'Koffi' },
    });
  });

  it('clés publiques : document JWKS', async () => {
    const key = {
      kid: 'k1',
      kty: 'EC',
      crv: 'P-256',
      x: 'x',
      y: 'y',
      alg: 'ES256',
      use: 'sig',
    } as const;
    await expect(new GetPublicKeysUseCase({ publicKeys: async () => [key] }).execute()).resolves.toEqual({
      keys: [key],
    });
  });
});
