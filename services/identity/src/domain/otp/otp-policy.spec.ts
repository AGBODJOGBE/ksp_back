import { decideSend, type OtpPolicy } from './otp-policy';

const policy: OtpPolicy = {
  codeLength: 6,
  ttlSeconds: 300,
  maxAttempts: 5,
  resendDelaySeconds: 60,
  maxPerHour: 5,
  maxPerDay: 10,
  blockSeconds: 3600,
};

const now = new Date('2026-10-17T12:00:00Z');
/** Dates d'envoi, en secondes avant maintenant. */
const sent = (...secondsAgo: number[]) => secondsAgo.map((s) => new Date(now.getTime() - s * 1000));

describe('decideSend : limites d’envoi par numéro', () => {
  it('autorise un premier envoi', () => {
    expect(decideSend([], now, policy)).toEqual({ allowed: true });
  });

  it('impose 60 secondes entre deux envois', () => {
    expect(decideSend(sent(20), now, policy)).toEqual({ allowed: false, retryAfterSeconds: 40 });
    expect(decideSend(sent(60), now, policy)).toEqual({ allowed: true });
  });

  it('bloque au-delà de 5 envois dans l’heure, jusqu’à ce que le plus ancien sorte de la fenêtre', () => {
    expect(decideSend(sent(100, 200, 300, 400, 3000), now, policy)).toEqual({
      allowed: false,
      retryAfterSeconds: 600,
    });
    expect(decideSend(sent(100, 200, 300, 400), now, policy)).toEqual({ allowed: true });
  });

  it('après 10 envois dans la journée, un seul envoi par heure', () => {
    const tenToday = sent(1800, 5000, 9000, 13000, 17000, 21000, 25000, 29000, 33000, 37000);
    expect(decideSend(tenToday, now, policy)).toEqual({ allowed: false, retryAfterSeconds: 1800 });
    const lastOneHourAgo = sent(3600, 5000, 9000, 13000, 17000, 21000, 25000, 29000, 33000, 37000);
    expect(decideSend(lastOneHourAgo, now, policy)).toEqual({ allowed: true });
  });

  it('ignore les envois de plus de 24 heures', () => {
    const old = sent(...Array.from({ length: 12 }, (_, i) => 90000 + i * 60));
    expect(decideSend(old, now, policy)).toEqual({ allowed: true });
  });
});
