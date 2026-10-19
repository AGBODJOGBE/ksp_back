import { AppError } from '@ksp/platform';
import { type OtpPolicy } from '../../domain/otp/otp-policy';
import { challengeState } from '../../domain/otp/otp-verification';
import { type ClientKind, type SessionPolicy } from '../../domain/session/session-policy';
import { type OtpChallengeRepository, type OtpHasher } from '../otp/otp.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import {
  type Account,
  type AccountRepository,
  ChallengeAlreadyConsumedError,
  type LoginRepository,
  PhoneAlreadyRegisteredError,
  type RefreshTokenGenerator,
} from './session.ports';

export interface VerifyOtpInput {
  challengeId: string;
  code: string;
  clientKind: ClientKind;
  deviceLabel: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface OpenedSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
  account: Account;
  profileIncomplete: boolean;
  isNewUser: boolean;
}

const expired = () =>
  AppError.precondition('IDENTITY_OTP_EXPIRED', 'Le code a expiré, demandez-en un nouveau.');
const exhausted = () =>
  AppError.precondition(
    'IDENTITY_OTP_TOO_MANY_ATTEMPTS',
    'Trop de codes faux : ce code est annulé, demandez-en un nouveau.',
  );

/**
 * UC-ID-01, seconde étape : valider le code. Un numéro inconnu crée le compte (actif et vérifié :
 * le code vaut vérification) ; puis une session est ouverte avec ses jetons.
 */
export class VerifyOtpUseCase {
  constructor(
    private readonly challenges: OtpChallengeRepository,
    private readonly accounts: AccountRepository,
    private readonly logins: LoginRepository,
    private readonly hasher: OtpHasher,
    private readonly refreshTokens: RefreshTokenGenerator,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly otpPolicy: OtpPolicy,
    private readonly sessionPolicy: SessionPolicy,
  ) {}

  async execute(input: VerifyOtpInput): Promise<OpenedSession> {
    if (input.clientKind === 'backoffice') {
      // Lot 1 : aucun compte interne n'existe encore ; le back-office exigera la double authentification.
      throw AppError.forbidden('IDENTITY_BACKOFFICE_FORBIDDEN', "Ce compte n'a pas accès au back-office.");
    }

    const now = this.clock.now();
    const challenge = await this.challenges.findById(input.challengeId);
    if (!challenge) throw expired();
    const state = challengeState(challenge, now, this.otpPolicy.maxAttempts);
    if (state === 'expired') throw expired();
    if (state === 'exhausted') throw exhausted();

    const account = await this.accounts.findByPhone(challenge.target);
    if (!this.hasher.matches(challenge.id, input.code, challenge.codeHash)) {
      const attempts = await this.challenges.registerFailedAttempt(challenge.id);
      await this.recordFailure(account?.id ?? null, 'otp_invalid', input);
      if (attempts >= this.otpPolicy.maxAttempts) throw exhausted();
      throw AppError.invalid('IDENTITY_OTP_INVALID', 'Le code est incorrect.', {
        attemptsRemaining: this.otpPolicy.maxAttempts - attempts,
      });
    }
    if (account?.status === 'suspended') {
      await this.recordFailure(account.id, 'account_suspended', input);
      throw AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'Ce compte est suspendu.');
    }

    return this.openSession(input, challenge.id, challenge.target, account, now, true);
  }

  private async openSession(
    input: VerifyOtpInput,
    challengeId: string,
    phoneE164: string,
    account: Account | null,
    now: Date,
    retryIfRaced: boolean,
  ): Promise<OpenedSession> {
    const refresh = this.refreshTokens.generate();
    const sessionId = this.ids.next();
    const refreshTokenExpiresAt = new Date(now.getTime() + this.sessionPolicy.refreshTtlSeconds * 1000);
    let result: { account: Account; isNewUser: boolean };
    try {
      result = await this.logins.completePhoneLogin({
        challengeId,
        phoneE164,
        existingUserId: account?.id ?? null,
        newUserId: this.ids.next(),
        newPhoneId: this.ids.next(),
        session: {
          id: sessionId,
          clientKind: input.clientKind,
          deviceLabel: input.deviceLabel,
          userAgent: input.userAgent,
          ip: input.ip,
          expiresAt: refreshTokenExpiresAt,
        },
        refreshToken: { id: this.ids.next(), hash: refresh.hash },
        loginEventId: this.ids.next(),
        maxSessions: this.sessionPolicy.maxSessions,
        now,
      });
    } catch (error) {
      if (error instanceof ChallengeAlreadyConsumedError) throw expired();
      if (error instanceof PhoneAlreadyRegisteredError && retryIfRaced) {
        // Deux validations simultanées pour un nouveau numéro : la seconde rejoint le compte créé.
        const created = await this.accounts.findByPhone(phoneE164);
        return this.openSession(input, challengeId, phoneE164, created, now, false);
      }
      throw error;
    }

    const access = await this.accessTokens.issue({
      userId: result.account.id,
      sessionId,
      clientId: input.clientKind,
      activeContext: 'personal',
      // Lot 1 : tout compte a le rôle client ; les rôles attribués viendront avec l'administration.
      roles: [{ role: 'customer', scopeType: 'personal' }],
      mfa: false,
      authTime: now,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt,
      sessionId,
      account: result.account,
      profileIncomplete: !result.account.firstName || !result.account.lastName,
      isNewUser: result.isNewUser,
    };
  }

  private recordFailure(userId: string | null, reason: string, input: VerifyOtpInput): Promise<void> {
    return this.logins.recordFailedLogin({
      id: this.ids.next(),
      userId,
      reason,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }
}
