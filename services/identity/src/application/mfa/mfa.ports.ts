import { type StoredMfaChallenge } from '../../domain/mfa/mfa-challenge';
import { type ClientKind } from '../../domain/session/session-policy';
import { type Account } from '../session/session.ports';

/** Étape de double authentification à ouvrir après un code par téléphone valide. */
export interface NewMfaChallenge {
  id: string;
  userId: string;
  tokenHash: string;
  clientKind: ClientKind;
  deviceLabel: string | null;
  ip: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface MfaChallengeRepository {
  /**
   * Consomme la demande de code par téléphone et ouvre l'étape, en une transaction.
   * Lève ChallengeAlreadyConsumedError si la demande a été utilisée entre-temps.
   */
  openAfterOtp(otpChallengeId: string, challenge: NewMfaChallenge, now: Date): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<StoredMfaChallenge | null>;
  /** Compte un code faux et renvoie le nombre d'essais, de façon atomique. */
  registerFailedAttempt(id: string): Promise<number>;
}

/** Application d'authentification d'un compte : secret chiffré, actif une fois confirmé. */
export interface TotpFactor {
  id: string;
  secretEncrypted: string;
  enabledAt: Date | null;
  /** Dernier pas de temps accepté (refus d'un code rejoué). */
  lastUsedStep: number | null;
}

export interface MfaFactorRepository {
  findTotp(userId: string): Promise<TotpFactor | null>;
  /**
   * Enregistre un secret en attente de confirmation, en remplaçant un secret non confirmé.
   * Lève TotpAlreadyEnabledError si l'application est déjà active.
   */
  savePendingTotp(input: { id: string; userId: string; secretEncrypted: string; now: Date }): Promise<void>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  /** Identifiant du code de récupération encore utilisable qui a cette empreinte, ou null. */
  findUnusedRecoveryCode(userId: string, codeHash: string): Promise<string | null>;
}

/** Ce que la seconde étape valide, appliqué dans la transaction qui ouvre la session. */
export type SecondFactorProof =
  /** Premier code : active l'application et remplace les codes de récupération. */
  | { kind: 'totp_enrollment'; factorId: string; step: number; recoveryCodes: { id: string; hash: string }[] }
  /** Code de l'application : le pas doit être postérieur au dernier pas accepté. */
  | { kind: 'totp'; factorId: string; step: number }
  /** Code de récupération : consommé. */
  | { kind: 'recovery_code'; codeId: string };

/** Écritures d'une connexion back-office réussie, faites en une seule transaction. */
export interface MfaLoginPlan {
  mfaChallengeId: string;
  userId: string;
  proof: SecondFactorProof;
  session: {
    id: string;
    clientKind: ClientKind;
    deviceLabel: string | null;
    userAgent: string | null;
    ip: string | null;
    expiresAt: Date;
  };
  refreshToken: { id: string; hash: string };
  loginEventId: string;
  maxSessions: number;
  now: Date;
}

/** L'étape a été consommée entre-temps (deux validations simultanées). */
export class MfaChallengeAlreadyConsumedError extends Error {
  override readonly name = 'MfaChallengeAlreadyConsumedError';
}

/** Un code du même pas, ou d'un pas plus récent, a été accepté entre-temps. */
export class TotpStepAlreadyUsedError extends Error {
  override readonly name = 'TotpStepAlreadyUsedError';
}

/** Le code de récupération a été consommé entre-temps. */
export class RecoveryCodeAlreadyUsedError extends Error {
  override readonly name = 'RecoveryCodeAlreadyUsedError';
}

/** L'application d'authentification est déjà active. */
export class TotpAlreadyEnabledError extends Error {
  override readonly name = 'TotpAlreadyEnabledError';
}

export interface MfaLoginRepository {
  /**
   * Consomme l'étape, applique la preuve, révoque les sessions du back-office au-delà de la limite,
   * ouvre la session (mfa_at renseigné) et enregistre la connexion. Renvoie le compte et le nombre
   * de codes de récupération encore utilisables.
   */
  completeMfaLogin(plan: MfaLoginPlan): Promise<{ account: Account; recoveryCodesRemaining: number }>;
}

/** Chiffrement du secret de l'application (AES-256-GCM, clé dans le coffre). */
export interface SecretCipher {
  /** `context` lie le chiffré à son propriétaire : un secret recopié sur un autre compte est illisible. */
  encrypt(plaintext: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
}

/** Calcul des codes TOTP (RFC 6238, HMAC-SHA1). */
export interface TotpGenerator {
  /** Nouveau secret aléatoire, en base32 sans remplissage. */
  generateSecret(): string;
  codeAt(secretBase32: string, step: number, digits: number): string;
}

export interface RecoveryCodeGenerator {
  /** Code sous sa forme canonique (10 caractères de l'alphabet de Crockford). */
  generate(): string;
}

/** Empreinte d'un code de récupération : la base ne contient jamais le code. */
export interface RecoveryCodeHasher {
  hash(userId: string, normalizedCode: string): string;
}

/** Jeton de double authentification : valeur aléatoire donnée au client, empreinte conservée. */
export interface MfaTokenGenerator {
  generate(): { token: string; hash: string };
  hash(token: string): string;
}
