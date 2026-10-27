import { activeContextOf } from '../../domain/context/active-context';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { challengeState } from '../../domain/otp/otp-verification';
import { isProfileIncomplete } from '../../domain/user/profile';
import { type Profile } from '../account/account.use-cases';
import { type OtpHasher } from '../otp/otp.ports';
import { type AccountRepository } from '../session/session.ports';
import { type Clock } from '../shared/system.ports';
import { emailErrors } from './email-errors';
import {
  EmailAlreadyUsedError,
  type EmailVerificationRepository,
  VerificationAlreadyConsumedError,
} from './email.ports';

export interface ConfirmEmailInput {
  userId: string;
  code: string;
  /** Contexte du jeton d'accès de l'appelant (claim ctx), renvoyé avec le profil. */
  activeContext: string;
}

/**
 * Confirmer l'e-mail du profil par le dernier code reçu : l'adresse devient l'e-mail vérifié du
 * compte (identity.user.verified, `verifiedVia: email`) et remplace l'ancienne.
 *
 * Seule la dernière demande du compte compte : un code d'une demande remplacée est expiré.
 * Les essais faux sont comptés sur la demande ; au-delà du maximum, elle est annulée.
 */
export class ConfirmEmailUseCase {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly verifications: EmailVerificationRepository,
    private readonly hasher: OtpHasher,
    private readonly clock: Clock,
    private readonly policy: OtpPolicy,
  ) {}

  async execute(input: ConfirmEmailInput): Promise<Profile> {
    const account = await this.accounts.findById(input.userId);
    if (!account || account.status === 'deleted') throw emailErrors.userNotFound();

    const now = this.clock.now();
    const verification = await this.verifications.findLatest(account.id);
    if (!verification) throw emailErrors.expired();
    const state = challengeState(verification, now, this.policy.maxAttempts);
    if (state === 'expired') throw emailErrors.expired();
    if (state === 'exhausted') throw emailErrors.exhausted();

    if (!this.hasher.matches(verification.id, input.code, verification.codeHash)) {
      const attempts = await this.verifications.registerFailedAttempt(verification.id);
      if (attempts >= this.policy.maxAttempts) throw emailErrors.exhausted();
      throw emailErrors.codeInvalid(this.policy.maxAttempts - attempts);
    }

    try {
      const confirmed = await this.verifications.confirm({
        verificationId: verification.id,
        userId: account.id,
        email: verification.target,
        now,
      });
      return {
        account: confirmed,
        profileIncomplete: isProfileIncomplete(confirmed),
        pendingEmail: null,
        activeContext: activeContextOf(input.activeContext),
      };
    } catch (error) {
      if (error instanceof VerificationAlreadyConsumedError) throw emailErrors.expired();
      if (error instanceof EmailAlreadyUsedError) throw emailErrors.alreadyUsed();
      throw error;
    }
  }
}
