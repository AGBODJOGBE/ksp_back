import { type ClientKind } from '../session/session-policy';

/** Règles de l'étape de double authentification. Valeurs issues de la configuration. */
export interface MfaPolicy {
  /** Durée de vie du jeton remis après le code par téléphone : 5 minutes. */
  tokenTtlSeconds: number;
  /** Codes faux acceptés par jeton ; au-delà, le jeton est annulé. */
  maxAttempts: number;
}

/** L'étape de double authentification ouverte par un code par téléphone valide. */
export interface StoredMfaChallenge {
  id: string;
  userId: string;
  /** Type de client de la connexion : le jeton ne sert qu'à lui. */
  clientKind: ClientKind;
  deviceLabel: string | null;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

export type MfaChallengeState = 'usable' | 'expired' | 'exhausted';

/** Un jeton expiré ou déjà utilisé est « expiré » pour l'utilisateur : la raison n'est pas donnée. */
export function mfaChallengeState(
  challenge: StoredMfaChallenge,
  now: Date,
  maxAttempts: number,
): MfaChallengeState {
  if (challenge.consumedAt || challenge.expiresAt <= now) return 'expired';
  return challenge.attempts >= maxAttempts ? 'exhausted' : 'usable';
}

export type SecondFactorMethod = 'totp' | 'recovery_code';

/**
 * Méthodes proposées à l'étape de double authentification : l'application d'authentification,
 * plus les codes de récupération s'il en reste. Jamais de SMS pour un compte interne (ADR-023).
 */
export function availableMethods(totpEnabled: boolean, unusedRecoveryCodes: number): SecondFactorMethod[] {
  if (!totpEnabled) return ['totp'];
  return unusedRecoveryCodes > 0 ? ['totp', 'recovery_code'] : ['totp'];
}
