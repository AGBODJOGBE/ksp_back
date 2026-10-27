import { decideSend, type OtpPolicy, strictest } from '../../domain/otp/otp-policy';
import { EmailAddress } from '../../domain/user/email-address';
import { type OtpCodeGenerator, type OtpHasher } from '../otp/otp.ports';
import { type AccountRepository } from '../session/session.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { emailErrors } from './email-errors';
import { type EmailCodeSender, type EmailVerificationRepository } from './email.ports';

export interface ChangeEmailInput {
  userId: string;
  email: string;
  ip: string | null;
}

export interface ChangeEmailOutput {
  /** Adresse à confirmer, normalisée. */
  pendingEmail: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Déclarer ou changer l'e-mail du profil : un code est envoyé à la nouvelle adresse. Rien ne
 * change dans le compte avant la confirmation (ConfirmEmailUseCase) : l'ancienne adresse, vérifiée,
 * reste celle du compte jusque-là. La demande remplace la précédente.
 *
 * - Mêmes règles que les codes par téléphone (UC-ID-01) : code haché, durée de validité, essais
 *   comptés, limites d'envoi, appliquées à la fois par adresse (une boîte ne peut pas être inondée
 *   par plusieurs comptes) et par compte (un compte ne peut pas écrire à de nombreuses adresses).
 * - Anti-énumération : la réponse ne dit pas si l'adresse est déjà celle d'un autre compte ;
 *   ce n'est signalé qu'après la saisie du bon code, qui prouve que l'adresse est à l'utilisateur.
 */
export class ChangeEmailUseCase {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly verifications: EmailVerificationRepository,
    private readonly sender: EmailCodeSender,
    private readonly hasher: OtpHasher,
    private readonly codes: OtpCodeGenerator,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: OtpPolicy,
  ) {}

  async execute(input: ChangeEmailInput): Promise<ChangeEmailOutput> {
    const email = EmailAddress.parse(input.email);
    if (!email) throw emailErrors.invalid();

    const account = await this.accounts.findById(input.userId);
    if (!account || account.status === 'deleted') throw emailErrors.userNotFound();
    if (account.email === email.value && account.emailVerifiedAt) throw emailErrors.alreadyVerified();

    const now = this.clock.now();
    const since = new Date(now.getTime() - DAY_MS);
    const [toEmail, byUser] = await Promise.all([
      this.verifications.sentAtForEmailSince(email, since),
      this.verifications.sentAtForUserSince(account.id, since),
    ]);
    const decision = strictest([decideSend(toEmail, now, this.policy), decideSend(byUser, now, this.policy)]);
    if (!decision.allowed) throw emailErrors.rateLimited(decision.retryAfterSeconds);

    const id = this.ids.next();
    const code = this.codes.generate(this.policy.codeLength);
    await this.verifications.create({
      id,
      userId: account.id,
      email,
      codeHash: this.hasher.hash(id, code),
      expiresAt: new Date(now.getTime() + this.policy.ttlSeconds * 1000),
      ip: input.ip,
      createdAt: now,
    });

    try {
      await this.sender.send({
        verificationId: id,
        userId: account.id,
        email,
        code,
        ttlSeconds: this.policy.ttlSeconds,
      });
    } catch (error) {
      await this.verifications.markSendFailed(id, this.clock.now());
      throw error;
    }

    const sentAt = this.clock.now();
    await this.verifications.markSent(id, sentAt, {
      userId: account.id,
      purpose: 'email_verification',
      channel: 'email',
      targetMasked: email.masked(),
    });

    const next = strictest([
      decideSend([...toEmail, sentAt], sentAt, this.policy),
      decideSend([...byUser, sentAt], sentAt, this.policy),
    ]);
    return {
      pendingEmail: email.value,
      expiresInSeconds: this.policy.ttlSeconds,
      resendAfterSeconds: next.allowed ? 0 : next.retryAfterSeconds,
    };
  }
}
