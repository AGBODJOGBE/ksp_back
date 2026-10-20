import { isProfileIncomplete } from '../../domain/user/profile';
import { AppError } from '@ksp/platform';
import { type SessionPolicy } from '../../domain/session/session-policy';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type AccessTokenIssuer } from '../token/access-token-issuer';
import { type SessionStore } from './session-store.ports';
import { type RefreshTokenGenerator } from './session.ports';
import { type OpenedSession } from './verify-otp.use-case';

const invalid = () =>
  AppError.unauthenticated('IDENTITY_REFRESH_TOKEN_INVALID', 'Votre session a expiré, reconnectez-vous.');
const reused = () =>
  AppError.unauthenticated(
    'IDENTITY_REFRESH_TOKEN_REUSED',
    'Par sécurité, votre session a été fermée. Reconnectez-vous.',
  );

/**
 * UC-ID-04 : renouveler la session. Chaque renouvellement remplace le jeton de renouvellement ;
 * un ancien jeton présenté de nouveau signale un vol : toute la session est révoquée.
 */
export class RefreshSessionUseCase {
  constructor(
    private readonly sessions: SessionStore,
    private readonly refreshTokens: RefreshTokenGenerator,
    private readonly hashRefreshToken: (token: string) => string,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policy: SessionPolicy,
  ) {}

  async execute(refreshToken: string): Promise<Omit<OpenedSession, 'isNewUser'>> {
    if (!refreshToken) throw invalid();
    const now = this.clock.now();
    const stored = await this.sessions.findRefreshToken(this.hashRefreshToken(refreshToken));
    if (!stored) throw invalid();

    const { session, account } = stored;
    if (session.revokedAt) {
      throw AppError.unauthenticated(
        'IDENTITY_SESSION_REVOKED',
        'Cette session a été fermée, reconnectez-vous.',
      );
    }
    if (stored.usedAt) {
      await this.sessions.revokeSession(session.id, account.id, 'refresh_token_reused', now);
      throw reused();
    }
    if (session.expiresAt <= now) throw invalid();
    if (account.status === 'suspended') {
      throw AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'Ce compte est suspendu.');
    }

    const next = this.refreshTokens.generate();
    const sessionExpiresAt = new Date(now.getTime() + this.policy.refreshTtlSeconds * 1000);
    const rotated = await this.sessions.rotateRefreshToken({
      oldTokenId: stored.id,
      newToken: { id: this.ids.next(), hash: next.hash },
      sessionId: session.id,
      sessionExpiresAt,
      now,
    });
    if (!rotated) {
      // Le même jeton a servi deux fois en même temps : on le traite comme une réutilisation.
      await this.sessions.revokeSession(session.id, account.id, 'refresh_token_reused', now);
      throw reused();
    }

    const access = await this.accessTokens.issue({
      userId: account.id,
      sessionId: session.id,
      clientId: session.clientKind,
      activeContext: 'personal',
      roles: [{ role: 'customer', scopeType: 'personal' }],
      mfa: false,
      // Heure de la connexion, pas du renouvellement : un renouvellement n'est pas une authentification.
      authTime: session.createdAt,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next.token,
      refreshTokenExpiresAt: sessionExpiresAt,
      sessionId: session.id,
      account,
      profileIncomplete: isProfileIncomplete(account),
    };
  }
}
