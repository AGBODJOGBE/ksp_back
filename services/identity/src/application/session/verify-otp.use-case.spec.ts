import { AppError } from '@ksp/platform';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { newOtpChallenge } from '../../domain/otp/otp-challenge';
import { PhoneNumber } from '../../domain/user/phone-number';
import { InMemoryChallenges, InMemoryIdentityStore } from '../testing/fakes';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import { type VerifyOtpInput, VerifyOtpUseCase } from './verify-otp.use-case';

const otpPolicy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  resendDelaySeconds: 60,
  maxPerHour: 5,
  maxPerDay: 10,
  blockSeconds: 3600,
};

function setup() {
  let now = new Date('2026-10-19T12:00:00Z');
  let seq = 0;
  const challenges = new InMemoryChallenges();
  const store = new InMemoryIdentityStore(challenges);
  const issued: { userId: string; clientId: string; roles: unknown }[] = [];
  const accessTokens = {
    issue: async (subject: { userId: string; clientId: string; roles: unknown }) => {
      issued.push(subject);
      return { token: `jwt-${subject.userId}`, tokenId: 'j', expiresAt: new Date(now.getTime() + 900_000) };
    },
  } as unknown as AccessTokenIssuer;
  const useCase = new VerifyOtpUseCase(
    challenges,
    store,
    store,
    {
      hash: (id, code) => `${id}:${code}`,
      matches: (id, code, hash) => hash === `${id}:${code}`,
    },
    { generate: () => ({ token: `rt-${++seq}`, hash: `h-rt-${seq}` }) },
    accessTokens,
    { next: () => `id-${++seq}` },
    { now: () => now },
    otpPolicy,
    { refreshTtlSeconds: 30 * 24 * 3600, maxSessions: 2 },
  );

  /** Une demande de code envoyée au numéro, avec le code 482913. */
  const sentChallenge = async (phone = '+2290197000045') => {
    const id = `c-${++seq}`;
    const challenge = newOtpChallenge({
      id,
      target: PhoneNumber.parse(phone)!,
      channel: 'whatsapp',
      purpose: 'login',
      codeHash: `${id}:482913`,
      ip: null,
      now,
      policy: otpPolicy,
    });
    await challenges.create(challenge);
    await challenges.markSent(id, 'whatsapp', now, {
      userId: null,
      purpose: 'login',
      channel: 'whatsapp',
      targetMasked: 'x',
    });
    return id;
  };
  const advance = (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000);
  };
  return { useCase, store, challenges, issued, sentChallenge, advance };
}

const input = (challengeId: string, change: Partial<VerifyOtpInput> = {}): VerifyOtpInput => ({
  challengeId,
  code: '482913',
  clientKind: 'mobile',
  deviceLabel: 'Téléphone Android',
  ip: '196.192.10.4',
  userAgent: 'KSP/1.0',
  ...change,
});

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('VerifyOtpUseCase (UC-ID-01, validation du code)', () => {
  it('crée le compte d’un numéro nouveau et ouvre une session', async () => {
    const { useCase, store, issued, sentChallenge } = setup();
    const opened = await useCase.execute(input(await sentChallenge()));

    expect(opened.isNewUser).toBe(true);
    expect(opened.profileIncomplete).toBe(true);
    expect(opened.account).toMatchObject({ status: 'active', phoneE164: '+2290197000045' });
    expect(store.registered).toEqual([opened.account.id]);
    expect(opened.refreshToken).toMatch(/^rt-/);
    expect(opened.refreshTokenExpiresAt).toEqual(new Date('2026-11-18T12:00:00Z'));
    expect(store.sessions).toEqual([
      expect.objectContaining({ id: opened.sessionId, userId: opened.account.id, clientKind: 'mobile' }),
    ]);
    expect(store.sessions[0].refreshTokenHash).not.toBe(opened.refreshToken);
    expect(issued).toEqual([
      expect.objectContaining({
        userId: opened.account.id,
        clientId: 'mobile',
        roles: [{ role: 'customer', scopeType: 'personal' }],
      }),
    ]);
  });

  it('reconnecte un compte existant sans en créer un autre', async () => {
    const { useCase, store, sentChallenge } = setup();
    const first = await useCase.execute(input(await sentChallenge()));
    const second = await useCase.execute(input(await sentChallenge()));
    expect(second.isNewUser).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(store.accounts).toHaveLength(1);
    expect(store.registered).toHaveLength(1);
  });

  it('un code ne sert qu’une fois', async () => {
    const { useCase, sentChallenge } = setup();
    const id = await sentChallenge();
    await useCase.execute(input(id));
    await expectAppError(useCase.execute(input(id)), 'IDENTITY_OTP_EXPIRED');
  });

  it('un code faux indique les essais restants et est enregistré dans l’historique', async () => {
    const { useCase, store, sentChallenge } = setup();
    const error = await expectAppError(
      useCase.execute(input(await sentChallenge(), { code: '000000' })),
      'IDENTITY_OTP_INVALID',
    );
    expect(error.details).toEqual({ attemptsRemaining: 4 });
    expect(store.loginEvents).toEqual([{ userId: null, success: false, reason: 'otp_invalid' }]);
  });

  it('au 5ᵉ code faux, le code est annulé, même si le bon arrive ensuite', async () => {
    const { useCase, sentChallenge } = setup();
    const id = await sentChallenge();
    for (let i = 0; i < 4; i += 1) {
      await expectAppError(useCase.execute(input(id, { code: '000000' })), 'IDENTITY_OTP_INVALID');
    }
    await expectAppError(useCase.execute(input(id, { code: '000000' })), 'IDENTITY_OTP_TOO_MANY_ATTEMPTS');
    await expectAppError(useCase.execute(input(id)), 'IDENTITY_OTP_TOO_MANY_ATTEMPTS');
  });

  it('un code expiré est refusé', async () => {
    const { useCase, sentChallenge, advance } = setup();
    const id = await sentChallenge();
    advance(301);
    await expectAppError(useCase.execute(input(id)), 'IDENTITY_OTP_EXPIRED');
  });

  it('une demande inconnue est traitée comme expirée', async () => {
    const { useCase } = setup();
    await expectAppError(useCase.execute(input('inconnue')), 'IDENTITY_OTP_EXPIRED');
  });

  it('un compte suspendu ne peut pas se connecter', async () => {
    const { useCase, store, sentChallenge } = setup();
    const { account } = await useCase.execute(input(await sentChallenge()));
    account.status = 'suspended';
    await expectAppError(useCase.execute(input(await sentChallenge())), 'IDENTITY_ACCOUNT_SUSPENDED');
    expect(store.loginEvents.at(-1)).toEqual({
      userId: account.id,
      success: false,
      reason: 'account_suspended',
    });
  });

  it('au-delà de la limite, la session la plus ancienne est révoquée', async () => {
    const { useCase, store, sentChallenge, advance } = setup();
    const first = await useCase.execute(input(await sentChallenge()));
    advance(60);
    await useCase.execute(input(await sentChallenge()));
    advance(60);
    await useCase.execute(input(await sentChallenge()));

    const active = store.sessions.filter((session) => !session.revokedAt);
    expect(active).toHaveLength(2);
    expect(store.sessions.find((session) => session.id === first.sessionId)).toMatchObject({
      revokeReason: 'session_limit',
    });
  });

  it('refuse le back-office au lot 1, avant même de lire le code', async () => {
    const { useCase, challenges, sentChallenge } = setup();
    const id = await sentChallenge();
    await expectAppError(
      useCase.execute(input(id, { clientKind: 'backoffice' })),
      'IDENTITY_BACKOFFICE_FORBIDDEN',
    );
    expect(challenges.rows.get(id)?.consumedAt).toBeUndefined();
  });
});
