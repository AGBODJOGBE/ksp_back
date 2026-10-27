import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { EmailAddress } from '../../domain/user/email-address';
import { type OtpCodeGenerator, type OtpHasher } from '../otp/otp.ports';
import { type AccountRepository } from '../session/session.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { EmailCodeIssuer, type IssuedEmailCode } from './email-code-issuer';
import { emailErrors } from './email-errors';
import { type EmailCodeSender, type EmailVerificationRepository } from './email.ports';

export interface ChangeEmailInput {
  userId: string;
  email: string;
  ip: string | null;
}

export type ChangeEmailOutput = IssuedEmailCode;

/**
 * Déclarer ou changer l'e-mail du profil : un code est envoyé à la nouvelle adresse. Rien ne
 * change dans le compte avant la confirmation (ConfirmEmailUseCase) : l'ancienne adresse, vérifiée,
 * reste celle du compte jusque-là. La demande remplace la précédente.
 *
 * - Mêmes règles que les codes par téléphone (UC-ID-01), voir EmailCodeIssuer.
 * - Anti-énumération : la réponse ne dit pas si l'adresse est déjà celle d'un autre compte ;
 *   ce n'est signalé qu'après la saisie du bon code, qui prouve que l'adresse est à l'utilisateur.
 */
export class ChangeEmailUseCase {
  private readonly issuer: EmailCodeIssuer;

  constructor(
    private readonly accounts: AccountRepository,
    verifications: EmailVerificationRepository,
    sender: EmailCodeSender,
    hasher: OtpHasher,
    codes: OtpCodeGenerator,
    ids: IdGenerator,
    clock: Clock,
    policy: OtpPolicy,
  ) {
    this.issuer = new EmailCodeIssuer(verifications, sender, hasher, codes, ids, clock, policy);
  }

  async execute(input: ChangeEmailInput): Promise<ChangeEmailOutput> {
    const email = EmailAddress.parse(input.email);
    if (!email) throw emailErrors.invalid();

    const account = await this.accounts.findById(input.userId);
    if (!account || account.status === 'deleted') throw emailErrors.userNotFound();
    if (account.email === email.value && account.emailVerifiedAt) throw emailErrors.alreadyVerified();

    return this.issuer.issue({ userId: account.id, email, ip: input.ip, organization: null });
  }
}
