import { type Organization } from '../../domain/organization/organization';
import { challengeState } from '../../domain/otp/otp-verification';
import { type Account } from '../session/session.ports';
import { type Clock } from '../shared/system.ports';
import { type EmailVerificationRepository } from './email.ports';

/**
 * Adresse en attente de confirmation, affichée dans le profil (ou la fiche d'une organisation pour
 * l'e-mail de facturation) : celle de la dernière demande, tant que son code est encore utilisable
 * (envoyé, ni expiré, ni annulé, ni utilisé).
 */
export class PendingEmails {
  constructor(
    private readonly verifications: Pick<
      EmailVerificationRepository,
      'findLatest' | 'findLatestForOrganization'
    >,
    private readonly clock: Clock,
    private readonly maxAttempts: number,
  ) {}

  async of(account: Account): Promise<string | null> {
    const latest = await this.verifications.findLatest(account.id);
    if (!latest || challengeState(latest, this.clock.now(), this.maxAttempts) !== 'usable') return null;
    return latest.target === account.email && account.emailVerifiedAt ? null : latest.target;
  }

  /** E-mail de facturation en attente de confirmation. */
  async ofOrganization(organization: Organization): Promise<string | null> {
    const latest = await this.verifications.findLatestForOrganization(organization.id);
    if (!latest || challengeState(latest, this.clock.now(), this.maxAttempts) !== 'usable') return null;
    return latest.target === organization.billingEmail ? null : latest.target;
  }
}
