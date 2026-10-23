import { type MfaPolicy, mfaChallengeState, type StoredMfaChallenge } from '../../domain/mfa/mfa-challenge';
import { type AssignedRole, backofficeRoles } from '../../domain/role/role';
import { type ClientKind } from '../../domain/session/session-policy';
import { type RoleRepository } from '../role/role.ports';
import {
  type Account,
  type AccountRepository,
  type LoginMethod,
  type LoginRepository,
} from '../session/session.ports';
import { type IdGenerator } from '../shared/system.ports';
import { mfaErrors } from './mfa-errors';
import { type MfaChallengeRepository, type MfaTokenGenerator } from './mfa.ports';

/** Ce qu'une étape de double authentification valide a établi. */
export interface MfaStep {
  challenge: StoredMfaChallenge;
  account: Account;
  /** Rôles actifs du compte, dont au moins un du back-office. */
  roles: AssignedRole[];
}

export interface ClientDetails {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Contrôles communs à EnrollTotp, ConfirmTotp et VerifyMfa : jeton connu, encore valable, présenté
 * par le type de client qui l'a obtenu ; compte actif qui a toujours un rôle du back-office.
 */
export class MfaStepGuard {
  constructor(
    private readonly challenges: MfaChallengeRepository,
    private readonly tokens: MfaTokenGenerator,
    private readonly accounts: AccountRepository,
    private readonly roles: RoleRepository,
    private readonly logins: LoginRepository,
    private readonly ids: IdGenerator,
    private readonly policy: MfaPolicy,
  ) {}

  async open(input: { mfaToken: string; clientKind: ClientKind }, now: Date): Promise<MfaStep> {
    if (!input.mfaToken) throw mfaErrors.tokenInvalid();
    const challenge = await this.challenges.findByTokenHash(this.tokens.hash(input.mfaToken));
    // Un jeton présenté par un autre type de client est traité comme inconnu.
    if (!challenge || challenge.clientKind !== input.clientKind) throw mfaErrors.tokenInvalid();
    const state = mfaChallengeState(challenge, now, this.policy.maxAttempts);
    if (state === 'expired') throw mfaErrors.tokenInvalid();
    if (state === 'exhausted') throw mfaErrors.tooManyAttempts();

    const account = await this.accounts.findById(challenge.userId);
    if (!account) throw mfaErrors.tokenInvalid();
    if (account.status === 'suspended') throw mfaErrors.accountSuspended();
    // Un rôle retiré entre les deux étapes ferme l'accès.
    const roles = await this.roles.activeRoles(account.id);
    if (backofficeRoles(roles).length === 0) throw mfaErrors.backofficeForbidden();
    return { challenge, account, roles };
  }

  /** Code faux ou rejoué : compte l'essai, l'enregistre dans l'historique, puis lève l'erreur. */
  async rejectCode(
    step: MfaStep,
    failure: { kind: 'invalid' | 'reused'; method: LoginMethod },
    client: ClientDetails,
  ): Promise<never> {
    const attempts = await this.challenges.registerFailedAttempt(step.challenge.id);
    await this.logins.recordFailedLogin({
      id: this.ids.next(),
      userId: step.account.id,
      reason: failure.kind === 'reused' ? 'mfa_code_reused' : 'mfa_code_invalid',
      ip: client.ip,
      userAgent: client.userAgent,
      method: failure.method,
    });
    if (attempts >= this.policy.maxAttempts) throw mfaErrors.tooManyAttempts();
    const remaining = this.policy.maxAttempts - attempts;
    throw failure.kind === 'reused' ? mfaErrors.codeReused(remaining) : mfaErrors.codeInvalid(remaining);
  }
}
