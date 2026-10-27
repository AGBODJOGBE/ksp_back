import { decideSend, type OtpPolicy, strictest } from '../../domain/otp/otp-policy';
import { type EmailAddress } from '../../domain/user/email-address';
import { type OtpCodeGenerator, type OtpHasher } from '../otp/otp.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { emailErrors } from './email-errors';
import { type EmailCodeSender, type EmailVerificationRepository } from './email.ports';

export interface IssuedEmailCode {
  /** Adresse à confirmer, normalisée. */
  pendingEmail: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Envoi d'un code de confirmation par e-mail, commun à l'e-mail du profil (ADR-026) et à l'e-mail
 * de facturation d'une organisation (ADR-027) :
 * - mêmes règles que les codes par téléphone (UC-ID-01) : code haché, durée de validité, essais
 *   comptés, limites d'envoi appliquées à la fois par adresse (une boîte ne peut pas être inondée
 *   par plusieurs comptes) et par compte (un compte ne peut pas écrire à de nombreuses adresses),
 *   toutes demandes confondues (profil et organisations) ;
 * - la demande est enregistrée avant l'envoi, marquée envoyée (événement identity.otp.requested)
 *   ou en échec ensuite.
 */
export class EmailCodeIssuer {
  constructor(
    private readonly verifications: EmailVerificationRepository,
    private readonly sender: EmailCodeSender,
    private readonly hasher: OtpHasher,
    private readonly codes: OtpCodeGenerator,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: OtpPolicy,
  ) {}

  async issue(input: {
    userId: string;
    email: EmailAddress;
    ip: string | null;
    /** E-mail de facturation de cette organisation ; null pour l'e-mail du profil. */
    organization: { id: string; legalName: string } | null;
  }): Promise<IssuedEmailCode> {
    const { userId, email } = input;
    const now = this.clock.now();
    const since = new Date(now.getTime() - DAY_MS);
    const [toEmail, byUser] = await Promise.all([
      this.verifications.sentAtForEmailSince(email, since),
      this.verifications.sentAtForUserSince(userId, since),
    ]);
    const decision = strictest([decideSend(toEmail, now, this.policy), decideSend(byUser, now, this.policy)]);
    if (!decision.allowed) throw emailErrors.rateLimited(decision.retryAfterSeconds);

    const id = this.ids.next();
    const code = this.codes.generate(this.policy.codeLength);
    await this.verifications.create({
      id,
      userId,
      organizationId: input.organization?.id ?? null,
      email,
      codeHash: this.hasher.hash(id, code),
      expiresAt: new Date(now.getTime() + this.policy.ttlSeconds * 1000),
      ip: input.ip,
      createdAt: now,
    });

    try {
      await this.sender.send({
        verificationId: id,
        userId,
        email,
        code,
        ttlSeconds: this.policy.ttlSeconds,
        ...(input.organization ? { organizationName: input.organization.legalName } : {}),
      });
    } catch (error) {
      await this.verifications.markSendFailed(id, this.clock.now());
      throw error;
    }

    const sentAt = this.clock.now();
    await this.verifications.markSent(id, sentAt, {
      userId,
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
