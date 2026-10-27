import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { challengeState } from '../../domain/otp/otp-verification';
import { type OtpHasher } from '../otp/otp.ports';
import { emailErrors } from './email-errors';
import { type EmailVerificationRepository, type StoredEmailVerification } from './email.ports';

/**
 * Contrôle du code saisi contre la dernière demande (profil ou organisation) : une demande
 * absente, expirée ou annulée est refusée ; un code faux est compté, et la demande est annulée
 * au-delà du nombre d'essais. Renvoie la demande à consommer.
 */
export async function checkEmailCode(
  verifications: Pick<EmailVerificationRepository, 'registerFailedAttempt'>,
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

  if (!hasher.matches(verification.id, code, verification.codeHash)) {
    const attempts = await verifications.registerFailedAttempt(verification.id);
    if (attempts >= policy.maxAttempts) throw emailErrors.exhausted();
    throw emailErrors.codeInvalid(policy.maxAttempts - attempts);
  }
  return verification;
}
