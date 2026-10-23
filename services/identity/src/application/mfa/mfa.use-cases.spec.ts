import { AppError } from '@ksp/platform';
import { newOtpChallenge } from '../../domain/otp/otp-challenge';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { TOTP_DEFAULTS } from '../../domain/mfa/totp';
import { type ClientKind } from '../../domain/session/session-policy';
import { PhoneNumber } from '../../domain/user/phone-number';
import { VerifyOtpUseCase } from '../session/verify-otp.use-case';
import { InMemoryChallenges, InMemoryIdentityStore } from '../testing/fakes';
import { InMemoryMfaStore, InMemoryRoles } from '../testing/mfa-fakes';
import { type AccessTokenIssuer, type AccessTokenSubject } from '../token/access-token-issuer';
import { BackofficeSessionOpener } from './backoffice-session-opener';
import { ConfirmTotpUseCase } from './confirm-totp.use-case';
import { EnrollTotpUseCase } from './enroll-totp.use-case';
import { type TotpGenerator } from './mfa.ports';
import { MfaStepGuard } from './mfa-step-guard';
import { OpenMfaChallenge } from './open-mfa-challenge';
import { VerifyMfaUseCase } from './verify-mfa.use-case';

const otpPolicy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  resendDelaySeconds: 60,
  maxPerHour: 50,
  maxPerDay: 100,
  blockSeconds: 3600,
};
const SECRET = 'JBSWY3DPEHPK3PXP';
const client = { ip: '196.192.10.4', userAgent: 'Mozilla/5.0' };

function setup() {
  let now = new Date('2026-10-19T12:00:00Z');
  let seq = 0;
  const ids = { next: () => `id-${++seq}` };
  const clock = { now: () => now };
  const challenges = new InMemoryChallenges();
  const store = new InMemoryIdentityStore(challenges);
  const roles = new InMemoryRoles();
  const mfa = new InMemoryMfaStore(challenges, store);

  const issued: AccessTokenSubject[] = [];
  const accessTokens = {
    issue: async (subject: AccessTokenSubject) => {
      issued.push(subject);
      return { token: `jwt-${issued.length}`, tokenId: 'j', expiresAt: new Date(now.getTime() + 900_000) };
    },
  } as unknown as AccessTokenIssuer;
  const refreshTokens = { generate: () => ({ token: `rt-${++seq}`, hash: `h-rt-${seq}` }) };
  const mfaTokens = {
    generate: () => {
      const token = `mfa-${++seq}`;
      return { token, hash: `h-${token}` };
    },
    hash: (token: string) => `h-${token}`,
  };
  const mfaPolicy = { tokenTtlSeconds: 300, maxAttempts: 5 };
  /** Codes déterministes, différents d'un pas à l'autre. */
  const totp: TotpGenerator = {
    generateSecret: () => SECRET,
    codeAt: (_secret, step, digits) => String((step * 7919) % 10 ** digits).padStart(digits, '0'),
  };
  const cipher = {
    encrypt: (plain: string, context: string) => `enc[${context}]${plain}`,
    decrypt: (encrypted: string, context: string) => {
      if (!encrypted.startsWith(`enc[${context}]`)) throw new Error('contexte');
      return encrypted.slice(`enc[${context}]`.length);
    },
  };
  let codeSeq = 0;
  const recoveryCodes = { generate: () => `RC${String(++codeSeq).padStart(8, '0')}` };
  const recoveryHasher = { hash: (userId: string, code: string) => `h(${userId}:${code})` };

  const guard = new MfaStepGuard(mfa, mfaTokens, store, roles, store, ids, mfaPolicy);
  const opener = new BackofficeSessionOpener(mfa, refreshTokens, accessTokens, ids, {
    refreshTtlSeconds: 12 * 3600,
    maxSessions: 2,
    slidingExpiry: false,
    idleTimeoutSeconds: 1800,
  });
  const verifyOtp = new VerifyOtpUseCase(
    challenges,
    store,
    store,
    { hash: (id, code) => `${id}:${code}`, matches: (id, code, hash) => hash === `${id}:${code}` },
    refreshTokens,
    accessTokens,
    ids,
    clock,
    otpPolicy,
    { refreshTtlSeconds: 30 * 24 * 3600, maxSessions: 5 },
    new OpenMfaChallenge(roles, mfa, mfa, mfaTokens, ids, mfaPolicy),
  );
  const enroll = new EnrollTotpUseCase(guard, mfa, totp, cipher, ids, clock, TOTP_DEFAULTS);
  const confirm = new ConfirmTotpUseCase(
    guard,
    mfa,
    totp,
    cipher,
    recoveryCodes,
    recoveryHasher,
    opener,
    ids,
    clock,
    TOTP_DEFAULTS,
  );
  const verify = new VerifyMfaUseCase(guard, mfa, totp, cipher, recoveryHasher, opener, clock, TOTP_DEFAULTS);

  /** Code par téléphone valide (482913) pour le numéro, puis sa validation. */
  const passOtp = async (clientKind: ClientKind) => {
    const id = `c-${++seq}`;
    const challenge = newOtpChallenge({
      id,
      target: PhoneNumber.parse('+2290197000045')!,
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
    return verifyOtp.execute({ challengeId: id, code: '482913', clientKind, deviceLabel: null, ...client });
  };
  /** Compte interne : créé par une connexion sur le site, puis rôle attribué. */
  const internalAccount = async (role = 'cleaning_supervisor') => {
    const outcome = await passOtp('web');
    if (outcome.status !== 'authenticated') throw new Error('session attendue');
    roles.assign(outcome.session.account.id, role);
    return outcome.session.account;
  };
  /** Première étape au back-office : renvoie le jeton de double authentification. */
  const backofficeLogin = async () => {
    const outcome = await passOtp('backoffice');
    if (outcome.status !== 'mfa_required') throw new Error('double authentification attendue');
    return outcome.challenge;
  };
  /** Code affiché par l'application, au pas courant décalé de `offset`. */
  const codeAt = (offset = 0) => totp.codeAt(SECRET, Math.floor(now.getTime() / 1000 / 30) + offset, 6);
  const advance = (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000);
  };
  /** Compte interne configuré : renvoie la réponse de la confirmation. */
  const enrolledAccount = async () => {
    await internalAccount();
    const { mfaToken } = await backofficeLogin();
    await enroll.execute({ mfaToken, clientKind: 'backoffice' });
    return confirm.execute({ mfaToken, code: codeAt(), clientKind: 'backoffice', ...client });
  };
  const totpInput = (mfaToken: string, code: string) => ({
    mfaToken,
    method: 'totp' as const,
    code,
    clientKind: 'backoffice' as const,
    ...client,
  });
  return {
    store,
    roles,
    mfa,
    issued,
    enroll,
    confirm,
    verify,
    internalAccount,
    backofficeLogin,
    enrolledAccount,
    passOtp,
    codeAt,
    advance,
    totpInput,
    clock,
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('EnrollTotp et ConfirmTotp (UC-ID-09, première connexion)', () => {
  it('crée le secret, chiffré et lié au compte, en attente de confirmation', async () => {
    const { enroll, mfa, internalAccount, backofficeLogin } = setup();
    const account = await internalAccount();
    const { mfaToken } = await backofficeLogin();
    const enrollment = await enroll.execute({ mfaToken, clientKind: 'backoffice' });

    expect(enrollment).toEqual({
      secret: SECRET,
      otpauthUri: `otpauth://totp/KSP:%2B2290197000045?secret=${SECRET}&issuer=KSP&algorithm=SHA1&digits=6&period=30`,
      issuer: 'KSP',
      accountName: '+2290197000045',
      digits: 6,
      periodSeconds: 30,
    });
    expect(mfa.factors).toEqual([
      expect.objectContaining({
        userId: account.id,
        secretEncrypted: `enc[${account.id}]${SECRET}`,
        enabledAt: null,
      }),
    ]);
  });

  it('le premier code active l’application, remet 10 codes de récupération et ouvre la session', async () => {
    const { store, mfa, issued, clock, enrolledAccount } = setup();
    const { session, recoveryCodes } = await enrolledAccount();

    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toBe('RC000-00001');
    // Seules les empreintes sont conservées.
    expect(mfa.recoveryCodes.map((code) => code.hash)).toContain(`h(${session.account.id}:RC00000001)`);
    expect(JSON.stringify(mfa.recoveryCodes)).not.toContain('RC000-00001');
    expect(mfa.factors[0]).toMatchObject({ enabledAt: clock.now() });

    expect(session.recoveryCodesRemaining).toBe(10);
    expect(session.refreshTokenExpiresAt).toEqual(new Date(clock.now().getTime() + 12 * 3600 * 1000));
    expect(store.sessions.at(-1)).toMatchObject({
      id: session.sessionId,
      clientKind: 'backoffice',
      mfaAt: clock.now(),
    });
    expect(issued.at(-1)).toMatchObject({
      clientId: 'backoffice',
      mfa: true,
      amr: ['otp', 'mfa'],
      authTime: clock.now(),
      roles: [
        { role: 'customer', scopeType: 'personal' },
        { role: 'cleaning_supervisor', scopeType: 'domain', scopeId: 'cleaning' },
      ],
    });
    expect(store.loginEvents.at(-1)).toEqual({ userId: session.account.id, success: true, method: 'totp' });
  });

  it('un premier code faux compte un essai, sans activer l’application', async () => {
    const { enroll, confirm, mfa, store, internalAccount, backofficeLogin, codeAt } = setup();
    await internalAccount();
    const { mfaToken } = await backofficeLogin();
    await enroll.execute({ mfaToken, clientKind: 'backoffice' });
    const error = await expectAppError(
      confirm.execute({ mfaToken, code: codeAt(5), clientKind: 'backoffice', ...client }),
      'IDENTITY_MFA_CODE_INVALID',
    );
    expect(error.details).toEqual({ attemptsRemaining: 4 });
    expect(mfa.factors[0]!.enabledAt).toBeNull();
    expect(store.loginEvents.at(-1)).toMatchObject({
      success: false,
      reason: 'mfa_code_invalid',
      method: 'totp',
    });
  });

  it('confirmer sans avoir commencé est refusé', async () => {
    const { confirm, internalAccount, backofficeLogin, codeAt } = setup();
    await internalAccount();
    const { mfaToken } = await backofficeLogin();
    await expectAppError(
      confirm.execute({ mfaToken, code: codeAt(), clientKind: 'backoffice', ...client }),
      'IDENTITY_MFA_ENROLLMENT_NOT_STARTED',
    );
  });

  it('une application déjà configurée ne se reconfigure pas par la connexion', async () => {
    const { enroll, enrolledAccount, backofficeLogin, advance } = setup();
    await enrolledAccount();
    advance(30);
    const { mfaToken, enrollmentRequired } = await backofficeLogin();
    expect(enrollmentRequired).toBe(false);
    await expectAppError(
      enroll.execute({ mfaToken, clientKind: 'backoffice' }),
      'IDENTITY_MFA_ALREADY_ENROLLED',
    );
  });
});

describe('VerifyMfa (UC-ID-09, connexions suivantes)', () => {
  it('code de l’application : session back-office ouverte', async () => {
    const { verify, store, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    advance(30);
    const { mfaToken } = await backofficeLogin();
    const session = await verify.execute(totpInput(mfaToken, codeAt()));
    expect(session.recoveryCodesRemaining).toBe(10);
    expect(store.sessions.at(-1)).toMatchObject({ id: session.sessionId, clientKind: 'backoffice' });
  });

  it('un code déjà utilisé est refusé, même dans sa fenêtre de validité', async () => {
    const { verify, enrolledAccount, backofficeLogin, codeAt, totpInput } = setup();
    await enrolledAccount();
    const { mfaToken } = await backofficeLogin();
    const error = await expectAppError(
      verify.execute(totpInput(mfaToken, codeAt())),
      'IDENTITY_MFA_CODE_REUSED',
    );
    expect(error.details).toEqual({ attemptsRemaining: 4 });
  });

  it('accepte le pas précédent (horloge du téléphone en retard), pas celui d’avant', async () => {
    const { verify, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    advance(90);
    const { mfaToken } = await backofficeLogin();
    await expectAppError(verify.execute(totpInput(mfaToken, codeAt(-2))), 'IDENTITY_MFA_CODE_INVALID');
    await expect(verify.execute(totpInput(mfaToken, codeAt(-1)))).resolves.toBeDefined();
  });

  it('un mauvais code indique les essais restants ; au 5ᵉ, le jeton est annulé', async () => {
    const { verify, store, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    advance(30);
    const { mfaToken } = await backofficeLogin();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const error = await expectAppError(
        verify.execute(totpInput(mfaToken, '000000')),
        'IDENTITY_MFA_CODE_INVALID',
      );
      expect(error.details).toEqual({ attemptsRemaining: 5 - attempt });
    }
    await expectAppError(verify.execute(totpInput(mfaToken, '000000')), 'IDENTITY_MFA_TOO_MANY_ATTEMPTS');
    await expectAppError(verify.execute(totpInput(mfaToken, codeAt())), 'IDENTITY_MFA_TOO_MANY_ATTEMPTS');
    expect(store.loginEvents.filter((event) => event.reason === 'mfa_code_invalid')).toHaveLength(5);
  });

  it('code de récupération : saisie tolérante, consommé, utilisable une seule fois', async () => {
    const { verify, enrolledAccount, backofficeLogin } = setup();
    const { recoveryCodes } = await enrolledAccount();
    const code = recoveryCodes[2]!.toLowerCase().replace('-', ' ');
    const recovery = (mfaToken: string) => ({
      mfaToken,
      method: 'recovery_code' as const,
      code,
      clientKind: 'backoffice' as const,
      ...client,
    });

    const first = await backofficeLogin();
    const session = await verify.execute(recovery(first.mfaToken));
    expect(session.recoveryCodesRemaining).toBe(9);

    const second = await backofficeLogin();
    expect(second.methods).toEqual(['totp', 'recovery_code']);
    await expectAppError(verify.execute(recovery(second.mfaToken)), 'IDENTITY_MFA_CODE_INVALID');
  });

  it('avant toute configuration, la vérification est refusée', async () => {
    const { verify, internalAccount, backofficeLogin, codeAt, totpInput } = setup();
    await internalAccount();
    const { mfaToken } = await backofficeLogin();
    await expectAppError(verify.execute(totpInput(mfaToken, codeAt())), 'IDENTITY_MFA_ENROLLMENT_REQUIRED');
  });

  it('deux connexions simultanées avec le même code : la seconde est refusée comme rejouée', async () => {
    const { verify, mfa, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    advance(30);
    const { mfaToken } = await backofficeLogin();
    mfa.raceOnNextLogin = true;
    await expectAppError(verify.execute(totpInput(mfaToken, codeAt())), 'IDENTITY_MFA_CODE_REUSED');
  });

  it('au plus 2 sessions back-office ; les sessions du site ne sont pas touchées', async () => {
    const { verify, store, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    for (let login = 0; login < 2; login += 1) {
      advance(30);
      const { mfaToken } = await backofficeLogin();
      await verify.execute(totpInput(mfaToken, codeAt()));
    }
    const active = store.sessions.filter((session) => !session.revokedAt);
    expect(active.filter((session) => session.clientKind === 'backoffice')).toHaveLength(2);
    expect(active.filter((session) => session.clientKind === 'web')).toHaveLength(1);
  });
});

describe('Jeton de double authentification', () => {
  it('expire après 5 minutes', async () => {
    const { verify, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    const { mfaToken } = await backofficeLogin();
    advance(301);
    await expectAppError(verify.execute(totpInput(mfaToken, codeAt())), 'IDENTITY_MFA_TOKEN_INVALID');
  });

  it('ne sert qu’une fois', async () => {
    const { verify, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    advance(30);
    const { mfaToken } = await backofficeLogin();
    await verify.execute(totpInput(mfaToken, codeAt()));
    advance(30);
    await expectAppError(verify.execute(totpInput(mfaToken, codeAt())), 'IDENTITY_MFA_TOKEN_INVALID');
  });

  it('est lié au type de client qui l’a obtenu, et un jeton inconnu est refusé', async () => {
    const { verify, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    advance(30);
    const { mfaToken } = await backofficeLogin();
    await expectAppError(
      verify.execute({ ...totpInput(mfaToken, codeAt()), clientKind: 'web' }),
      'IDENTITY_MFA_TOKEN_INVALID',
    );
    await expectAppError(verify.execute(totpInput('inconnu', codeAt())), 'IDENTITY_MFA_TOKEN_INVALID');
    await expectAppError(verify.execute(totpInput('', codeAt())), 'IDENTITY_MFA_TOKEN_INVALID');
  });

  it('un rôle retiré ou un compte suspendu entre les deux étapes ferme l’accès', async () => {
    const { verify, roles, store, enrolledAccount, backofficeLogin, advance, codeAt, totpInput } = setup();
    await enrolledAccount();
    advance(30);
    const first = await backofficeLogin();
    roles.assignments.forEach((assignment) => (assignment.revokedAt = new Date()));
    await expectAppError(
      verify.execute(totpInput(first.mfaToken, codeAt())),
      'IDENTITY_BACKOFFICE_FORBIDDEN',
    );

    roles.assignments.forEach((assignment) => (assignment.revokedAt = null));
    const second = await backofficeLogin();
    store.accounts[0]!.status = 'suspended';
    await expectAppError(verify.execute(totpInput(second.mfaToken, codeAt())), 'IDENTITY_ACCOUNT_SUSPENDED');
  });
});
