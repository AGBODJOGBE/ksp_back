import { PERSONAL_CONTEXT } from '../../domain/context/active-context';
import { canBeActiveContext } from '../../domain/organization/organization';
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
import { type OrganizationRepository } from '../organization/organization.ports';
import { backofficeRoleClaims, organizationRoleClaims, personalRoleClaims } from '../role/role-claims';
import { type RoleRepository } from '../role/role.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type AccessTokenIssuer, type AccessTokenSubject } from '../token/access-token-issuer';
import { type SessionStore, type StoredRefreshToken } from './session-store.ports';
import { type RefreshTokenSuccessor } from './session.ports';
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
 * Délai de grâce (ADR-050) : quelques secondes après son remplacement, l'ancien jeton renvoie le
 * même successeur (dérivé de lui avec une clé secrète), tant que ce successeur n'a pas servi ;
 * deux onglets qui renouvellent ensemble gardent ainsi la session.
 * Back-office : échéance fixe, fermeture après inactivité, rôles relus à chaque renouvellement
 * (un rôle retiré prend effet ici, UC-ID-19).
 * Sites et applications : le contexte actif de la session est gardé (UC-ID-15) tant que
 * l'organisation est validée et l'utilisateur membre ; sinon, retour au contexte personnel (ADR-027).
 */
export class RefreshSessionUseCase {
  constructor(
    private readonly sessions: SessionStore,
    private readonly refreshTokens: RefreshTokenSuccessor,
    private readonly hashRefreshToken: (token: string) => string,
    private readonly accessTokens: AccessTokenIssuer,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly policies: SessionPolicies,
    private readonly roles: RoleRepository,
    private readonly organizations: Pick<OrganizationRepository, 'membership'>,
    /** Délai pendant lequel un jeton remplacé renvoie encore son successeur (10 s par défaut). */
    private readonly reuseGraceSeconds: number,
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
    const next = this.refreshTokens.successor(refreshToken);
    if (stored.usedAt && !this.withinGrace(stored, next.hash, now)) {
      await this.sessions.revokeSession(session.id, account.id, 'refresh_token_reused', now);
      throw reused();
    }
    if (session.expiresAt <= now) throw invalid();
    if (account.status === 'suspended') {
      throw AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'Ce compte est suspendu.');
    }
    if (account.status === 'deleted') throw invalid();

    const policy = this.policies[sessionCategory(session.clientKind)];
    if (isIdleExpired(session.lastSeenAt, now, policy)) {
      await this.sessions.revokeSession(session.id, account.id, 'idle_timeout', now);
      throw invalid();
    }
    const grants = await this.grantsOf(stored, now);
    const context = await this.contextOf(stored);

    const sessionExpiresAt = renewedExpiry(session.expiresAt, now, policy);
    if (!stored.usedAt) {
      const rotated = await this.sessions.rotateRefreshToken({
        oldTokenId: stored.id,
        newToken: { id: this.ids.next(), hash: next.hash },
        sessionId: session.id,
        sessionExpiresAt,
        activeOrgId: context.organizationId,
        now,
      });
      // Le même jeton a servi en même temps ailleurs : l'autre appel a enregistré le même successeur.
      const latest = rotated
        ? null
        : await this.sessions.findRefreshToken(this.hashRefreshToken(refreshToken));
      if (!rotated && !(latest && this.withinGrace(latest, next.hash, now))) {
        await this.sessions.revokeSession(session.id, account.id, 'refresh_token_reused', now);
        throw reused();
      }
    }

    const access = await this.accessTokens.issue({
      userId: account.id,
      sessionId: session.id,
      clientId: session.clientKind,
      activeContext: context.organizationId ?? PERSONAL_CONTEXT,
      organizationName: context.organizationName,
      ...grants,
      ...(context.roles ? { roles: context.roles } : {}),
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

  /** Jeton remplacé il y a moins du délai de grâce par ce successeur, qui n'a pas encore servi. */
  private withinGrace(stored: StoredRefreshToken, successorHash: string, now: Date): boolean {
    return (
      stored.usedAt !== null &&
      now.getTime() - stored.usedAt.getTime() <= this.reuseGraceSeconds * 1000 &&
      stored.successor?.hash === successorHash &&
      stored.successor.usedAt === null
    );
  }

  /**
   * Organisation active gardée par le renouvellement, avec les rôles du membre ; null (contexte
   * personnel) si la session n'en a pas, si l'organisation n'est plus validée ou si l'utilisateur
   * n'en est plus membre. Le back-office reste toujours dans le contexte personnel.
   */
  private async contextOf(stored: StoredRefreshToken): Promise<{
    organizationId: string | null;
    organizationName: string | null;
    roles: AccessTokenSubject['roles'] | null;
  }> {
    const { session, account } = stored;
    const personal = { organizationId: null, organizationName: null, roles: null };
    if (!session.activeOrgId || sessionCategory(session.clientKind) !== 'customer') return personal;
    // Compte en cours de suppression : contexte personnel seul, session restreinte (ADR-036).
    if (account.status === 'deletion_pending') return personal;
    const membership = await this.organizations.membership(account.id, session.activeOrgId);
    if (!membership || !canBeActiveContext(membership.organization.status)) return personal;
    return {
      organizationId: membership.organization.id,
      organizationName: membership.organization.legalName,
      roles: organizationRoleClaims(membership.organization.id, membership.role),
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
      // Compte en cours de suppression : session restreinte (ADR-036), jusqu'à l'annulation.
      return {
        roles: personalRoleClaims(account.status),
        mfa: false,
        authTime: session.createdAt,
        amr: ['otp'],
      };
    }
    const assigned = await this.roles.activeRoles(account.id);
    if (!session.mfaAt || backofficeRoles(assigned).length === 0) {
      await this.sessions.revokeSession(session.id, account.id, 'backoffice_access_removed', now);
      throw mfaErrors.backofficeForbidden();
    }
    return { roles: backofficeRoleClaims(assigned), mfa: true, authTime: session.mfaAt, amr: ['otp', 'mfa'] };
  }
}
