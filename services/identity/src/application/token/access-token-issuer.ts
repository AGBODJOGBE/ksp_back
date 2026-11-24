import {
  ACCESS_TOKEN,
  ACCOUNT_DELETION_PENDING_ROLE,
  type AccessTokenAuthMethod,
  type AccessTokenClaims,
  type AccessTokenRoleClaim,
} from '@ksp/contracts';
import { type ActiveContext, activeContextOf } from '../../domain/context/active-context';
import { type EffectivePermissions, effectivePermissions } from '../../domain/role/permission';
import { type RoleRepository } from '../role/role.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type TokenSigner } from './token.ports';

export interface AccessTokenSubject {
  userId: string;
  sessionId: string;
  clientId: AccessTokenClaims['client_id'];
  /** "personal" ou identifiant de l'organisation active (UC-ID-15). */
  activeContext: string;
  /** Raison sociale de l'organisation active, renvoyée aux fronts (pas écrite dans le jeton). */
  organizationName?: string | null;
  roles: AccessTokenRoleClaim[];
  mfa: boolean;
  /** Dernière authentification forte. */
  authTime: Date;
  /** Méthodes d'authentification de la session (RFC 8176). */
  amr: AccessTokenAuthMethod[];
  /**
   * Session du back-office : permissions valables partout (claim perms) et limitées à des zones
   * (claim zone_perms, omis s'il est vide). Absents pour une session des sites et applications :
   * l'émetteur y écrit lui-même les permissions des rôles de terrain du compte, s'il en a.
   */
  perms?: string[];
  zonePerms?: Record<string, string[]>;
}

export interface IssuedAccessToken {
  token: string;
  tokenId: string;
  expiresAt: Date;
  /** Contexte écrit dans le jeton (claim ctx), tel que les services métier le lisent. */
  activeContext: ActiveContext;
}

/**
 * Émet un jeton d'accès conforme au contrat contracts/tokens/access-token.v1.schema.json
 * (profil RFC 9068). Utilisé à l'ouverture et au renouvellement d'une session.
 *
 * Permissions hors du back-office (CDC Nettoyage v2, R-RB-07) : une session de l'application agent
 * ou du portail porte perms et zone_perms pour les seuls rôles du compte qui ne donnent pas accès au
 * back-office (agent de terrain, partenaire) ; les permissions des rôles du back-office restent
 * réservées à une session du back-office. Un compte sans rôle de terrain garde un jeton sans
 * permissions, comme avant ; la session restreinte d'un compte en cours de suppression aussi.
 */
export class AccessTokenIssuer {
  constructor(
    private readonly signer: TokenSigner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
    /** Rôles actifs du compte, relus à chaque jeton : un rôle retiré prend effet au renouvellement. */
    private readonly fieldRoles?: Pick<RoleRepository, 'activeRoles'>,
  ) {}

  async issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
    const { perms, zonePerms } = await this.permissionsOf(subject);
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const claims: AccessTokenClaims = {
      iss: ACCESS_TOKEN.issuer,
      aud: ACCESS_TOKEN.audience,
      sub: subject.userId,
      client_id: subject.clientId,
      iat: issuedAt,
      exp: issuedAt + this.ttlSeconds,
      jti: this.ids.next(),
      token_use: 'access',
      sid: subject.sessionId,
      ctx: subject.activeContext,
      roles: subject.roles,
      mfa: subject.mfa,
      auth_time: Math.floor(subject.authTime.getTime() / 1000),
      amr: subject.amr,
      ...(perms ? { perms } : {}),
      ...(zonePerms && Object.keys(zonePerms).length ? { zone_perms: zonePerms } : {}),
    };
    const token = await this.signer.sign({ ...claims }, ACCESS_TOKEN.type);
    return {
      token,
      tokenId: claims.jti,
      expiresAt: new Date(claims.exp * 1000),
      activeContext: activeContextOf(claims.ctx, subject.organizationName ?? null),
    };
  }

  /** Permissions écrites dans le jeton : celles du back-office reçues, ou celles des rôles de terrain. */
  private async permissionsOf(subject: AccessTokenSubject): Promise<Partial<EffectivePermissions>> {
    const given = { perms: subject.perms, zonePerms: subject.zonePerms };
    if (subject.clientId === 'backoffice' || subject.perms !== undefined || !this.fieldRoles) return given;
    if (subject.roles.some((claim) => claim.role === ACCOUNT_DELETION_PENDING_ROLE)) return {};
    const field = (await this.fieldRoles.activeRoles(subject.userId)).filter(
      (role) => !role.backofficeAccess,
    );
    return field.length ? effectivePermissions(field, { allPermissions: [] }) : {};
  }
}
