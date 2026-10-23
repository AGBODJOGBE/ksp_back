import { AppError } from '@ksp/platform';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { newOtpChallenge } from '../../domain/otp/otp-challenge';
import { PhoneNumber } from '../../domain/user/phone-number';
import { OpenMfaChallenge } from '../mfa/open-mfa-challenge';
import { InMemoryChallenges, InMemoryIdentityStore } from '../testing/fakes';
import { InMemoryMfaStore, InMemoryRoles } from '../testing/mfa-fakes';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import { type VerifyOtpInput, VerifyOtpUseCase } from './verify-otp.use-case';

/** Validation qui doit ouvrir une session (sites et applications). */
async function login(useCase: VerifyOtpUseCase, verify: VerifyOtpInput) {
  const outcome = await useCase.execute(verify);
  if (outcome.status !== 'authenticated') throw new Error('session attendue');
  return outcome.session;
}

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
  const roles = new InMemoryRoles();
  const mfa = new InMemoryMfaStore(challenges, store);
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
    new OpenMfaChallenge(
      roles,
      mfa,
      mfa,
      { generate: () => ({ token: `mfa-${++seq}`, hash: `h-mfa-${seq}` }), hash: (token) => `h-${token}` },
      { next: () => `id-${++seq}` },
      { tokenTtlSeconds: 300, maxAttempts: 5 },
    ),
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
  return { useCase, store, challenges, roles, mfa, issued, sentChallenge, advance };
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
    const opened = await login(useCase, input(await sentChallenge()));

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
    const first = await login(useCase, input(await sentChallenge()));
    const second = await login(useCase, input(await sentChallenge()));
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
    const { account } = await login(useCase, input(await sentChallenge()));
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
    const first = await login(useCase, input(await sentChallenge()));
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
});

describe('VerifyOtpUseCase (UC-ID-09, connexion au back-office)', () => {
  const backoffice = (challengeId: string) => input(challengeId, { clientKind: 'backoffice' });

  it('refuse un numéro inconnu sans créer de compte', async () => {
    const { useCase, store, challenges, sentChallenge } = setup();
    const id = await sentChallenge();
    await expectAppError(useCase.execute(backoffice(id)), 'IDENTITY_BACKOFFICE_FORBIDDEN');
    expect(store.accounts).toHaveLength(0);
    expect(store.loginEvents).toEqual([{ userId: null, success: false, reason: 'backoffice_forbidden' }]);
    expect(challenges.rows.get(id)?.consumedAt).toBeUndefined();
  });

  it('refuse un compte sans rôle du back-office', async () => {
    const { useCase, store, sentChallenge } = setup();
    const { account } = await login(useCase, input(await sentChallenge()));
    await expectAppError(useCase.execute(backoffice(await sentChallenge())), 'IDENTITY_BACKOFFICE_FORBIDDEN');
    expect(store.loginEvents.at(-1)).toMatchObject({ userId: account.id, reason: 'backoffice_forbidden' });
  });

  it('un code faux reste un code faux, avant toute question de rôle', async () => {
    const { useCase, sentChallenge } = setup();
    const id = await sentChallenge();
    await expectAppError(useCase.execute({ ...backoffice(id), code: '000000' }), 'IDENTITY_OTP_INVALID');
  });

  it('première connexion d’un compte interne : configuration obligatoire, pas de session', async () => {
    const { useCase, store, roles, mfa, challenges, issued, sentChallenge } = setup();
    const { account } = await login(useCase, input(await sentChallenge()));
    roles.assign(account.id, 'cleaning_supervisor');
    const id = await sentChallenge();
    const outcome = await useCase.execute(backoffice(id));

    expect(outcome).toEqual({
      status: 'mfa_required',
      challenge: {
        mfaToken: expect.stringMatching(/^mfa-/),
        expiresAt: new Date('2026-10-19T12:05:00Z'),
        methods: ['totp'],
        enrollmentRequired: true,
      },
    });
    const stored = [...mfa.challenges.values()];
    expect(stored).toEqual([
      expect.objectContaining({
        userId: account.id,
        clientKind: 'backoffice',
        deviceLabel: 'Téléphone Android',
      }),
    ]);
    // Seule l'empreinte du jeton est conservée.
    expect(stored[0]!.tokenHash).not.toBe(outcome.status === 'mfa_required' && outcome.challenge.mfaToken);
    expect(challenges.rows.get(id)?.consumedAt).toBeDefined();
    expect(store.sessions.filter((session) => session.clientKind === 'backoffice')).toHaveLength(0);
    expect(issued).toHaveLength(1);
  });

  it('compte déjà configuré : application ou code de récupération', async () => {
    const { useCase, roles, mfa, sentChallenge } = setup();
    const { account } = await login(useCase, input(await sentChallenge()));
    roles.assign(account.id, 'super_admin');
    mfa.factors.push({
      id: 'f',
      userId: account.id,
      secretEncrypted: 's',
      enabledAt: new Date(),
      lastUsedStep: null,
    });
    mfa.recoveryCodes.push({ id: 'r', userId: account.id, hash: 'h', usedAt: null });
    const outcome = await useCase.execute(backoffice(await sentChallenge()));
    expect(outcome).toMatchObject({
      status: 'mfa_required',
      challenge: { methods: ['totp', 'recovery_code'], enrollmentRequired: false },
    });
  });

  it('le code par téléphone est consommé : il ne rouvre pas une seconde étape', async () => {
    const { useCase, roles, sentChallenge } = setup();
    const { account } = await login(useCase, input(await sentChallenge()));
    roles.assign(account.id, 'support_agent');
    const id = await sentChallenge();
    await useCase.execute(backoffice(id));
    await expectAppError(useCase.execute(backoffice(id)), 'IDENTITY_OTP_EXPIRED');
  });
});
