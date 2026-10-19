/** Ce qu'il faut savoir d'une demande de code pour la valider. */
export interface StoredOtpChallenge {
  id: string;
  target: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  sentAt: Date | null;
  sendFailedAt: Date | null;
  consumedAt: Date | null;
}

export type ChallengeState = 'usable' | 'expired' | 'exhausted';

/**
 * Une demande jamais envoyée, déjà utilisée ou expirée est « expirée » pour l'utilisateur :
 * la réponse ne dit pas laquelle de ces raisons s'applique.
 */
export function challengeState(
  challenge: StoredOtpChallenge,
  now: Date,
  maxAttempts: number,
): ChallengeState {
  if (!challenge.sentAt || challenge.sendFailedAt || challenge.consumedAt || challenge.expiresAt <= now) {
    return 'expired';
  }
  return challenge.attempts >= maxAttempts ? 'exhausted' : 'usable';
}
