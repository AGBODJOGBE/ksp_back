import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { challengeState } from '../../domain/otp/otp-verification';
import { type OtpHasher } from '../otp/otp.ports';
import { emailErrors } from './email-errors';
import { type EmailVerificationRepository, type StoredEmailVerification } from './email.ports';

/**
 * Contrôle du code saisi contre la dernière demande (profil ou organisation) : une demande
 * absente, expirée ou annulée est refusée ; l'essai est pris avant la comparaison (ADR-050), et la
 * demande est annulée au-delà du nombre d'essais. Renvoie la demande à consommer.
 */
export async function checkEmailCode(
  verifications: Pick<EmailVerificationRepository, 'takeAttempt'>,
  hasher: OtpHasher,
  policy: OtpPolicy,
  verification: StoredEmailVerification | null,
  code: string,
  now: Date,
): Promise<StoredEmailVerification> {
  if (!verification) throw emailErrors.expired();
  const state = challengeState(verification, now, policy.maxAttempts);
  if (state === 'expired') throw emailErrors.expired();
  if (state === 'exhausted') throw emailErrors.exhausted();

  // Demande devenue inutilisable entre-temps : essais pris par des essais simultanés, ou consommée.
  const attempts = await verifications.takeAttempt(verification.id, policy.maxAttempts, now);
  if (attempts === null) throw emailErrors.exhausted();
  if (!hasher.matches(verification.id, code, verification.codeHash)) {
    if (attempts >= policy.maxAttempts) throw emailErrors.exhausted();
    throw emailErrors.codeInvalid(policy.maxAttempts - attempts);
  }
  return verification;
}
