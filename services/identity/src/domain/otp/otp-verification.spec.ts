import { challengeState, type StoredOtpChallenge } from './otp-verification';

const now = new Date('2026-10-19T12:00:00Z');
const challenge = (change: Partial<StoredOtpChallenge> = {}): StoredOtpChallenge => ({
  id: 'c-1',
  target: '+2290197000045',
  codeHash: 'h',
  attempts: 0,
  expiresAt: new Date('2026-10-19T12:05:00Z'),
  sentAt: new Date('2026-10-19T12:00:00Z'),
  sendFailedAt: null,
  consumedAt: null,
  ...change,
});

describe('challengeState', () => {
  it('une demande envoyée, non utilisée et non expirée est utilisable', () => {
    expect(challengeState(challenge(), now, 5)).toBe('usable');
  });

  it.each([
    ['jamais envoyée', { sentAt: null }],
    ['dont l’envoi a échoué', { sendFailedAt: now }],
    ['déjà utilisée', { consumedAt: now }],
    ['expirée', { expiresAt: now }],
  ])('une demande %s est expirée', (_label, change) => {
    expect(challengeState(challenge(change), now, 5)).toBe('expired');
  });

  it('après 5 essais faux, la demande est épuisée', () => {
    expect(challengeState(challenge({ attempts: 5 }), now, 5)).toBe('exhausted');
  });
});
