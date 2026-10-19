import { AppError } from '@ksp/platform';
import { type OtpChannel } from '../../domain/otp/otp-challenge';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { InMemoryChallenges } from '../testing/fakes';
import { type OtpSender } from './otp.ports';
import { RequestOtpUseCase } from './request-otp.use-case';

const policy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  resendDelaySeconds: 60,
  maxPerHour: 5,
  maxPerDay: 10,
  blockSeconds: 3600,
};

class FakeSender implements OtpSender {
  readonly sent: { challengeId: string; code: string; channel: OtpChannel; ttlSeconds: number }[] = [];
  failWith: Error | null = null;
  switchTo: OtpChannel | null = null;

  async send(input: { challengeId: string; channel: OtpChannel; code: string; ttlSeconds: number }) {
    if (this.failWith) throw this.failWith;
    this.sent.push(input);
    return { channelUsed: this.switchTo ?? input.channel };
  }
}

function setup() {
  let now = new Date('2026-10-17T12:00:00Z');
  let seq = 0;
  const challenges = new InMemoryChallenges();
  const sender = new FakeSender();
  const useCase = new RequestOtpUseCase(
    challenges,
    sender,
    { hash: (id, code) => `hmac(${id}:${code})`, matches: () => false },
    { generate: (length) => '4'.repeat(length) },
    { next: () => `00000000-0000-7000-8000-${String(++seq).padStart(12, '0')}` },
    { now: () => now },
    policy,
  );
  const advance = (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000);
  };
  return { useCase, challenges, sender, advance };
}

const request = {
  phone: '+2290197000045',
  channel: 'sms' as const,
  purpose: 'login' as const,
  ip: '196.192.10.4',
};

async function expectAppError(promise: Promise<unknown>, code: string): Promise<AppError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  return error as AppError;
}

describe('RequestOtpUseCase (UC-ID-01, demande de code)', () => {
  it('envoie un code de 6 chiffres et répond avec la demande', async () => {
    const { useCase, sender } = setup();
    const result = await useCase.execute(request);

    expect(result).toEqual({
      challengeId: '00000000-0000-7000-8000-000000000001',
      maskedTarget: '+229********45',
      channel: 'sms',
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    });
    expect(sender.sent).toEqual([
      {
        challengeId: result.challengeId,
        target: expect.anything(),
        channel: 'sms',
        code: '444444',
        ttlSeconds: 300,
      },
    ]);
  });

  it('ne conserve jamais le code en clair, ni en base ni dans l’événement', async () => {
    const { useCase, challenges } = setup();
    const { challengeId } = await useCase.execute(request);

    const row = challenges.rows.get(challengeId)!;
    expect(row.codeHash).toBe(`hmac(${challengeId}:444444)`);
    expect(JSON.stringify([...challenges.rows.values()])).not.toContain('"444444"');
    expect(challenges.events).toEqual([
      { userId: null, purpose: 'login', channel: 'sms', targetMasked: '+229********45' },
    ]);
    expect(JSON.stringify(challenges.events)).not.toContain('444444');
  });

  it('enregistre l’échéance, l’adresse IP et le canal réellement utilisé', async () => {
    const { useCase, challenges, sender } = setup();
    sender.switchTo = 'whatsapp';
    const result = await useCase.execute(request);

    const row = challenges.rows.get(result.challengeId)!;
    expect(row.expiresAt).toEqual(new Date('2026-10-17T12:05:00Z'));
    expect(row.ip).toBe('196.192.10.4');
    expect(row.channelUsed).toBe('whatsapp');
    expect(result.channel).toBe('whatsapp');
    expect(challenges.events[0].channel).toBe('whatsapp');
  });

  it('répond de la même façon pour n’importe quel numéro (anti-énumération)', async () => {
    const { useCase } = setup();
    const a = await useCase.execute(request);
    const b = await useCase.execute({ ...request, phone: '+33612345678' });
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect({ ...a, challengeId: '', maskedTarget: '' }).toEqual({ ...b, challengeId: '', maskedTarget: '' });
  });

  it('refuse un numéro invalide sans rien envoyer', async () => {
    const { useCase, sender, challenges } = setup();
    await expectAppError(useCase.execute({ ...request, phone: '0197000045' }), 'IDENTITY_PHONE_INVALID');
    expect(sender.sent).toHaveLength(0);
    expect(challenges.rows.size).toBe(0);
  });

  it('impose le délai entre deux envois et indique quand réessayer', async () => {
    const { useCase, sender, advance } = setup();
    await useCase.execute(request);
    advance(20);
    const error = await expectAppError(useCase.execute(request), 'IDENTITY_OTP_RATE_LIMITED');
    expect(error.kind).toBe('RESOURCE_EXHAUSTED');
    expect(error.details).toEqual({ retryAfterSeconds: 40 });
    expect(sender.sent).toHaveLength(1);
  });

  it('applique les limites par numéro, pas globalement', async () => {
    const { useCase } = setup();
    await useCase.execute(request);
    await expect(useCase.execute({ ...request, phone: '+33612345678' })).resolves.toBeDefined();
  });

  it('bloque le 6ᵉ envoi de l’heure', async () => {
    const { useCase, advance } = setup();
    for (let i = 0; i < 5; i += 1) {
      await useCase.execute(request);
      advance(60);
    }
    await expectAppError(useCase.execute(request), 'IDENTITY_OTP_RATE_LIMITED');
  });

  it('si l’envoi échoue, la demande est marquée inutilisable et ne compte pas dans les limites', async () => {
    const { useCase, sender, challenges } = setup();
    sender.failWith = AppError.unavailable('IDENTITY_OTP_SEND_FAILED', 'Envoi impossible.');
    await expectAppError(useCase.execute(request), 'IDENTITY_OTP_SEND_FAILED');

    const [row] = challenges.rows.values();
    expect(row.sendFailedAt).toBeDefined();
    expect(row.sentAt).toBeUndefined();
    expect(challenges.events).toHaveLength(0);

    sender.failWith = null;
    await expect(useCase.execute(request)).resolves.toBeDefined();
  });
});
