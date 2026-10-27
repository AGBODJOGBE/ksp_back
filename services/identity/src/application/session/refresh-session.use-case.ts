import { PERSONAL_CONTEXT } from '../../domain/context/active-context';
import { isProfileIncomplete } from '../../domain/user/profile';
import { AppError } from '@ksp/platform';
import { backofficeRoles } from '../../domain/role/role';
import {
  isIdleExpired,
  renewedExpiry,
  type SessionCategory,
  sessionCategory,
  type SessionPolicy,
} from '../../domain/session/session-policy';
import { mfaErrors } from '../mfa/mfa-errors';
import { backofficeRoleClaims, CUSTOMER_ROLE } from '../role/role-claims';
import { type RoleRepository } from '../role/role.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type AccessTokenIssuer, type AccessTokenSubject } from '../token/access-token-issuer';
import { type SessionStore, type StoredRefreshToken } from './session-store.ports';
import { type RefreshTokenGenerator } from './session.ports';
import { type OpenedSession } from './verify-otp.use-case';

const invalid = () =>
  AppError.unauthenticated('IDENTITY_REFRESH_TOKEN_INVALID', 'Votre session a expiré, reconnectez-vous.');
const reused = () =>
  AppError.unauthenticated(
    'IDENTITY_REFRESH_TOKEN_REUSED',
    'Par sécurité, votre session a été fermée. Reconnectez-vous.',
  );

/** Règles de session par catégorie : sites et applications, back-office. */
export type SessionPolicies = Record<SessionCategory, SessionPolicy>;

/**
 * UC-ID-04 : renouveler la session. Chaque renouvellement remplace le jeton de renouvellement ;
 * un ancien jeton présenté de nouveau signale un vol : toute la session est révoquée.
 * Back-office : échéance fixe, fermeture après inactivité, rôles relus à chaque renouvellement
 * (un rôle retiré prend effet ici, UC-ID-19).
 */
export class RefreshSessionUseCase {
  constructor(
    private readonly sessions: SessionStore,
    private readonly refreshTokens: RefreshTokenGenerator,
    private readonly hashRefreshToken: (token: string) => string,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policies: SessionPolicies,
    private readonly roles: RoleRepository,
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

    const policy = this.policies[sessionCategory(session.clientKind)];
    if (isIdleExpired(session.lastSeenAt, now, policy)) {
      await this.sessions.revokeSession(session.id, account.id, 'idle_timeout', now);
      throw invalid();
    }
    const grants = await this.grantsOf(stored, now);

    const next = this.refreshTokens.generate();
    const sessionExpiresAt = renewedExpiry(session.expiresAt, now, policy);
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
      activeContext: PERSONAL_CONTEXT,
      ...grants,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next.token,
      refreshTokenExpiresAt: sessionExpiresAt,
      sessionId: session.id,
      account,
      profileIncomplete: isProfileIncomplete(account),
      activeContext: access.activeContext,
    };
  }

  /** Rôles et authentification écrits dans le nouveau jeton d'accès. */
  private async grantsOf(
    stored: StoredRefreshToken,
    now: Date,
  ): Promise<Pick<AccessTokenSubject, 'roles' | 'mfa' | 'authTime' | 'amr'>> {
    const { session, account } = stored;
    if (sessionCategory(session.clientKind) === 'customer') {
      // Heure de la connexion, pas du renouvellement : un renouvellement n'est pas une authentification.
      return { roles: [CUSTOMER_ROLE], mfa: false, authTime: session.createdAt, amr: ['otp'] };
    }
    const assigned = await this.roles.activeRoles(account.id);
    if (!session.mfaAt || backofficeRoles(assigned).length === 0) {
      await this.sessions.revokeSession(session.id, account.id, 'backoffice_access_removed', now);
      throw mfaErrors.backofficeForbidden();
    }
    return { roles: backofficeRoleClaims(assigned), mfa: true, authTime: session.mfaAt, amr: ['otp', 'mfa'] };
  }
}
