import { availableMethods, mfaChallengeState, type StoredMfaChallenge } from './mfa-challenge';

const now = new Date('2026-10-21T10:00:00Z');
const challenge = (change: Partial<StoredMfaChallenge> = {}): StoredMfaChallenge => ({
  id: 'm-1',
  userId: 'u-1',
  clientKind: 'backoffice',
  deviceLabel: null,
  attempts: 0,
  expiresAt: new Date(now.getTime() + 60_000),
  consumedAt: null,
  ...change,
});

describe('jeton de double authentification', () => {
  it('utilisable avant son expiration', () => {
    expect(mfaChallengeState(challenge(), now, 5)).toBe('usable');
    expect(mfaChallengeState(challenge({ attempts: 4 }), now, 5)).toBe('usable');
  });

  it('expiré, ou déjà utilisé : même réponse', () => {
    expect(mfaChallengeState(challenge({ expiresAt: now }), now, 5)).toBe('expired');
    expect(mfaChallengeState(challenge({ consumedAt: now }), now, 5)).toBe('expired');
  });

  it('annulé après le nombre maximal de codes faux', () => {
    expect(mfaChallengeState(challenge({ attempts: 5 }), now, 5)).toBe('exhausted');
  });
});

describe('méthodes proposées', () => {
  it('première connexion : configuration de l’application uniquement', () => {
    expect(availableMethods(false, 0)).toEqual(['totp']);
  });

  it('application configurée : codes de récupération tant qu’il en reste, jamais de SMS', () => {
    expect(availableMethods(true, 10)).toEqual(['totp', 'recovery_code']);
    expect(availableMethods(true, 0)).toEqual(['totp']);
  });
});
