import { isProfileIncomplete } from '../../domain/user/profile';
import { type SessionPolicy } from '../../domain/session/session-policy';
import { backofficeRoleClaims } from '../role/role-claims';
import { type OpenedSession } from '../session/verify-otp.use-case';
import { type RefreshTokenGenerator } from '../session/session.ports';
import { type IdGenerator } from '../shared/system.ports';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import { mfaErrors } from './mfa-errors';
import {
  MfaChallengeAlreadyConsumedError,
  type MfaLoginRepository,
  type SecondFactorProof,
} from './mfa.ports';
import { type ClientDetails, type MfaStep } from './mfa-step-guard';

export type BackofficeSession = Omit<OpenedSession, 'isNewUser'> & { recoveryCodesRemaining: number };

/**
 * Fin d'une connexion au back-office : écritures en une transaction (preuve, session, historique),
 * puis jeton d'accès avec les rôles du compte, mfa = true et amr = otp + mfa.
 * Les erreurs de course sur la preuve (TotpStepAlreadyUsedError, RecoveryCodeAlreadyUsedError)
 * remontent au cas d'usage, qui sait les traduire.
 */
export class BackofficeSessionOpener {
  constructor(
    private readonly logins: MfaLoginRepository,
    private readonly refreshTokens: RefreshTokenGenerator,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly ids: IdGenerator,
    private readonly policy: SessionPolicy,
  ) {}

  async open(
    step: MfaStep,
    proof: SecondFactorProof,
    client: ClientDetails,
    now: Date,
  ): Promise<BackofficeSession> {
    const refresh = this.refreshTokens.generate();
    const sessionId = this.ids.next();
    const refreshTokenExpiresAt = new Date(now.getTime() + this.policy.refreshTtlSeconds * 1000);
    let result: Awaited<ReturnType<MfaLoginRepository['completeMfaLogin']>>;
    try {
      result = await this.logins.completeMfaLogin({
        mfaChallengeId: step.challenge.id,
        userId: step.account.id,
        proof,
        session: {
          id: sessionId,
          clientKind: step.challenge.clientKind,
          deviceLabel: step.challenge.deviceLabel,
          userAgent: client.userAgent,
          ip: client.ip,
          expiresAt: refreshTokenExpiresAt,
        },
        refreshToken: { id: this.ids.next(), hash: refresh.hash },
        loginEventId: this.ids.next(),
        maxSessions: this.policy.maxSessions,
        now,
      });
    } catch (error) {
      if (error instanceof MfaChallengeAlreadyConsumedError) throw mfaErrors.tokenInvalid();
      throw error;
    }

    const access = await this.accessTokens.issue({
      userId: result.account.id,
      sessionId,
      clientId: step.challenge.clientKind,
      activeContext: 'personal',
      roles: backofficeRoleClaims(step.roles),
      mfa: true,
      authTime: now,
      amr: ['otp', 'mfa'],
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt,
      sessionId,
      account: result.account,
      profileIncomplete: isProfileIncomplete(result.account),
      recoveryCodesRemaining: result.recoveryCodesRemaining,
    };
  }
}
