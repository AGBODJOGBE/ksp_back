import { ActiveContexts } from '../context/active-contexts';
import { AppError } from '@ksp/platform';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import {
  InMemoryChallenges,
  InMemoryEmailVerifications,
  InMemoryOrganizations,
  InMemoryIdentityStore,
} from '../testing/fakes';
import { ChangeEmailUseCase } from './change-email.use-case';
import { ConfirmEmailUseCase } from './confirm-email.use-case';
import { type EmailCodeSender } from './email.ports';
import { PendingEmails } from './pending-email';

const policy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 900,
  maxAttempts: 5,
  resendDelaySeconds: 60,
  maxPerHour: 5,
  maxPerDay: 10,
  blockSeconds: 3600,
};

class FakeEmailSender implements EmailCodeSender {
  readonly sent: {
    verificationId: string;
    userId: string;
    email: string;
    code: string;
    ttlSeconds: number;
  }[] = [];
  failWith: Error | null = null;

  async send(input: Parameters<EmailCodeSender['send']>[0]): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ ...input, email: input.email.value });
  }
}

const account = (id: string, phone: string) => ({
  id,
  status: 'active' as const,
  firstName: 'Koffi',
  lastName: 'Adjovi',
  phoneE164: phone,
  email: null as string | null,
  emailVerifiedAt: null as Date | null,
  preferredLanguage: 'fr',
  createdAt: new Date('2026-10-19T12:00:00Z'),
});

function setup() {
  let now = new Date('2026-10-27T12:00:00Z');
  let seq = 0;
  let nextCode = '482913';
  const store = new InMemoryIdentityStore(new InMemoryChallenges());
  store.accounts.push(account('u-1', '+2290197000045'), account('u-2', '+2290197000046'));
  const verifications = new InMemoryEmailVerifications(store);
  const sender = new FakeEmailSender();
  const hasher = {
    hash: (id: string, code: string) => `hmac(${id}:${code})`,
    matches: (id: string, code: string, hash: string) => hash === `hmac(${id}:${code})`,
  };
  const clock = { now: () => now };
  const change = new ChangeEmailUseCase(
    store,
    verifications,
    sender,
    hasher,
    { generate: () => nextCode },
    { next: () => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}` },
    clock,
    policy,
  );
  const confirm = new ConfirmEmailUseCase(
    store,
    verifications,
    hasher,
    clock,
    policy,
    new ActiveContexts(new InMemoryOrganizations()),
  );
  const pending = new PendingEmails(verifications, clock, policy.maxAttempts);
  return {
    store,
    verifications,
    sender,
    change,
    confirm,
    pending,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
    codeWillBe: (code: string) => {
      nextCode = code;
    },
  };
}

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('ChangeEmailUseCase (déclarer ou changer son e-mail)', () => {
  it('envoie un code à la nouvelle adresse, normalisée, sans rien changer au compte', async () => {
    const { change, sender, verifications, store } = setup();
    const result = await change.execute({ userId: 'u-1', email: '  Koffi@Exemple.COM ', ip: '196.192.10.4' });

    expect(result).toEqual({
      pendingEmail: 'koffi@exemple.com',
      expiresInSeconds: 900,
      resendAfterSeconds: 60,
    });
    expect(sender.sent).toEqual([
      {
        verificationId: '00000000-0000-7000-8000-000000000001',
        userId: 'u-1',
        email: 'koffi@exemple.com',
        code: '482913',
        ttlSeconds: 900,
      },
    ]);
    expect(verifications.rows[0]).toMatchObject({
      codeHash: 'hmac(00000000-0000-7000-8000-000000000001:482913)',
      ip: '196.192.10.4',
    });
    expect(verifications.events).toEqual([
      { userId: 'u-1', purpose: 'email_verification', channel: 'email', targetMasked: 'k***@exemple.com' },
    ]);
    expect(store.accounts[0]).toMatchObject({ email: null, emailVerifiedAt: null });
  });

  it('refuse une adresse mal formée, sans rien envoyer', async () => {
    const { change, sender } = setup();
    await expectAppError(
      change.execute({ userId: 'u-1', email: 'koffi@', ip: null }),
      'IDENTITY_EMAIL_INVALID',
    );
    expect(sender.sent).toEqual([]);
  });

  it('refuse l’adresse déjà vérifiée du compte', async () => {
    const { change, store } = setup();
    Object.assign(store.accounts[0], { email: 'koffi@exemple.com', emailVerifiedAt: new Date() });
    await expectAppError(
      change.execute({ userId: 'u-1', email: 'KOFFI@exemple.com', ip: null }),
      'IDENTITY_EMAIL_ALREADY_VERIFIED',
    );
  });

  it('répond de la même façon si l’adresse est celle d’un autre compte (anti-énumération)', async () => {
    const { change, store } = setup();
    Object.assign(store.accounts[1], { email: 'koffi@exemple.com', emailVerifiedAt: new Date() });
    await expect(change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null })).resolves.toEqual({
      pendingEmail: 'koffi@exemple.com',
      expiresInSeconds: 900,
      resendAfterSeconds: 60,
    });
  });

  it('un compte supprimé ne peut pas déclarer d’adresse', async () => {
    const { change, store } = setup();
    store.accounts[0].status = 'deleted' as never;
    await expectAppError(
      change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null }),
      'IDENTITY_USER_NOT_FOUND',
    );
  });

  it('impose 60 secondes entre deux envois d’un même compte, même vers une autre adresse', async () => {
    const { change, advance } = setup();
    await change.execute({ userId: 'u-1', email: 'a@exemple.com', ip: null });
    advance(20);
    const error = await expectAppError(
      change.execute({ userId: 'u-1', email: 'b@exemple.com', ip: null }),
      'IDENTITY_OTP_RATE_LIMITED',
    );
    expect(error.details).toEqual({ retryAfterSeconds: 40 });
  });

  it('limite aussi les envois vers une même adresse, quel que soit le compte', async () => {
    const { change } = setup();
    await change.execute({ userId: 'u-1', email: 'cible@exemple.com', ip: null });
    await expectAppError(
      change.execute({ userId: 'u-2', email: 'cible@exemple.com', ip: null }),
      'IDENTITY_OTP_RATE_LIMITED',
    );
  });

  it('envoi impossible : la demande est marquée en échec et l’erreur remonte', async () => {
    const { change, sender, verifications, pending, store } = setup();
    sender.failWith = AppError.unavailable('IDENTITY_OTP_SEND_FAILED', 'Envoi impossible.');
    await expectAppError(
      change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null }),
      'IDENTITY_OTP_SEND_FAILED',
    );
    expect(verifications.rows[0].sendFailedAt).toBeDefined();
    expect(verifications.events).toEqual([]);
    await expect(pending.of(store.accounts[0])).resolves.toBeNull();
  });
});

describe('ConfirmEmailUseCase (confirmer son e-mail par le code)', () => {
  it('le bon code enregistre l’adresse comme e-mail vérifié du compte', async () => {
    const { change, confirm, store, verifications } = setup();
    await change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null });

    const profile = await confirm.execute({ userId: 'u-1', code: '482913', activeContext: 'personal' });
    expect(profile).toMatchObject({
      account: { id: 'u-1', email: 'koffi@exemple.com', emailVerifiedAt: new Date('2026-10-27T12:00:00Z') },
      profileIncomplete: false,
      pendingEmail: null,
      activeContext: { type: 'individual', organizationId: null },
    });
    expect(store.accounts[0].email).toBe('koffi@exemple.com');
    expect(verifications.verifiedEvents).toEqual(['u-1']);
  });

  it('garde l’ancienne adresse vérifiée tant que la nouvelle n’est pas confirmée', async () => {
    const { change, confirm, store, pending, advance, codeWillBe } = setup();
    const verifiedAt = new Date('2026-10-01T08:00:00Z');
    Object.assign(store.accounts[0], { email: 'ancienne@exemple.com', emailVerifiedAt: verifiedAt });

    codeWillBe('111111');
    await change.execute({ userId: 'u-1', email: 'nouvelle@exemple.com', ip: null });
    expect(store.accounts[0]).toMatchObject({ email: 'ancienne@exemple.com', emailVerifiedAt: verifiedAt });
    await expect(pending.of(store.accounts[0])).resolves.toBe('nouvelle@exemple.com');

    advance(30);
    await confirm.execute({ userId: 'u-1', code: '111111', activeContext: 'personal' });
    expect(store.accounts[0].email).toBe('nouvelle@exemple.com');
    await expect(pending.of(store.accounts[0])).resolves.toBeNull();
  });

  it('un code faux est compté ; au 5e, la demande est annulée', async () => {
    const { change, confirm } = setup();
    await change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null });

    const first = await expectAppError(
      confirm.execute({ userId: 'u-1', code: '000000', activeContext: 'personal' }),
      'IDENTITY_OTP_INVALID',
    );
    expect(first.details).toEqual({ attemptsRemaining: 4 });
    for (let i = 0; i < 3; i++) {
      await expectAppError(
        confirm.execute({ userId: 'u-1', code: '000000', activeContext: 'personal' }),
        'IDENTITY_OTP_INVALID',
      );
    }
    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '000000', activeContext: 'personal' }),
      'IDENTITY_OTP_TOO_MANY_ATTEMPTS',
    );
    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '482913', activeContext: 'personal' }),
      'IDENTITY_OTP_TOO_MANY_ATTEMPTS',
    );
  });

  it('un code expiré, déjà utilisé ou sans demande est refusé', async () => {
    const { change, confirm, advance } = setup();
    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '482913', activeContext: 'personal' }),
      'IDENTITY_OTP_EXPIRED',
    );

    await change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null });
    advance(900);
    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '482913', activeContext: 'personal' }),
      'IDENTITY_OTP_EXPIRED',
    );

    advance(60);
    await change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null });
    await confirm.execute({ userId: 'u-1', code: '482913', activeContext: 'personal' });
    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '482913', activeContext: 'personal' }),
      'IDENTITY_OTP_EXPIRED',
    );
  });

  it('seule la dernière demande compte : le code d’une demande remplacée est expiré', async () => {
    const { change, confirm, advance, codeWillBe, store } = setup();
    codeWillBe('111111');
    await change.execute({ userId: 'u-1', email: 'a@exemple.com', ip: null });
    advance(60);
    codeWillBe('222222');
    await change.execute({ userId: 'u-1', email: 'b@exemple.com', ip: null });

    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '111111', activeContext: 'personal' }),
      'IDENTITY_OTP_INVALID',
    );
    await confirm.execute({ userId: 'u-1', code: '222222', activeContext: 'personal' });
    expect(store.accounts[0].email).toBe('b@exemple.com');
  });

  it('une adresse déjà vérifiée par un autre compte est signalée après le bon code seulement', async () => {
    const { change, confirm, store } = setup();
    Object.assign(store.accounts[1], { email: 'koffi@exemple.com', emailVerifiedAt: new Date() });
    await change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null });

    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '000000', activeContext: 'personal' }),
      'IDENTITY_OTP_INVALID',
    );
    await expectAppError(
      confirm.execute({ userId: 'u-1', code: '482913', activeContext: 'personal' }),
      'IDENTITY_EMAIL_ALREADY_USED',
    );
    expect(store.accounts[0].email).toBeNull();
  });

  it('le code d’un compte ne confirme pas l’adresse d’un autre', async () => {
    const { change, confirm } = setup();
    await change.execute({ userId: 'u-1', email: 'koffi@exemple.com', ip: null });
    await expectAppError(
      confirm.execute({ userId: 'u-2', code: '482913', activeContext: 'personal' }),
      'IDENTITY_OTP_EXPIRED',
    );
  });
});
