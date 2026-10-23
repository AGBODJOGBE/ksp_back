import {
  ACCESS_TOKEN,
  type AccessTokenAuthMethod,
  type AccessTokenClaims,
  type AccessTokenRoleClaim,
} from '@ksp/contracts';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { type TokenSigner } from './token.ports';

export interface AccessTokenSubject {
  userId: string;
  sessionId: string;
  clientId: AccessTokenClaims['client_id'];
  /** "personal" ou identifiant de l'organisation active (UC-ID-15). */
  activeContext: string;
  roles: AccessTokenRoleClaim[];
  mfa: boolean;
  /** Dernière authentification forte. */
  authTime: Date;
  /** Méthodes d'authentification de la session (RFC 8176). */
  amr: AccessTokenAuthMethod[];
}

export interface IssuedAccessToken {
  token: string;
  tokenId: string;
  expiresAt: Date;
}

/**
 * Émet un jeton d'accès conforme au contrat contracts/tokens/access-token.v1.schema.json
 * (profil RFC 9068). Utilisé à l'ouverture et au renouvellement d'une session.
 */
export class AccessTokenIssuer {
  constructor(
    private readonly signer: TokenSigner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly ttlSeconds: number,
  ) {}

  async issue(subject: AccessTokenSubject): Promise<IssuedAccessToken> {
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
    };
    const token = await this.signer.sign({ ...claims }, ACCESS_TOKEN.type);
    return { token, tokenId: claims.jti, expiresAt: new Date(claims.exp * 1000) };
  }
}
