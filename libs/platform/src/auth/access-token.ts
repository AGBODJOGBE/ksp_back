import { ACCESS_TOKEN, type AccessTokenClaims } from '@ksp/contracts';
import { createRemoteJWKSet, errors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { type UserContext } from '../context/request-context';
import { AppError } from '../errors/app-error';

export interface AccessTokenVerifierOptions {
  keys: JWTVerifyGetKey;
  /** Tolérance d'horloge entre serveurs (cahier des charges Gateway, partie 8 : 30 secondes). */
  clockToleranceSeconds?: number;
}

/** Utilisateur authentifié par un jeton d'accès, prêt à être transmis aux services. */
export interface VerifiedAccessToken {
  user: UserContext;
  clientId: AccessTokenClaims['client_id'];
  tokenId: string;
  expiresAt: number;
}

/**
 * Vérifie un jeton d'accès émis par identity (profil RFC 9068, contrat contracts/tokens) :
 * signature ES256 uniquement, type at+jwt, émetteur, destinataire, expiration, token_use = access.
 * Utilisé par la gateway ; aucun appel à identity par requête, les clés publiques sont en cache.
 */
export class AccessTokenVerifier {
  constructor(private readonly options: AccessTokenVerifierOptions) {}

  /** Clés lues sur l'adresse JWKS d'identity, gardées en cache et rechargées si une clé est inconnue. */
  static fromJwksUrl(jwksUrl: string): AccessTokenVerifier {
    return new AccessTokenVerifier({ keys: createRemoteJWKSet(new URL(jwksUrl)) });
  }

  async verify(token: string): Promise<VerifiedAccessToken> {
    let claims: AccessTokenClaims;
    try {
      const { payload } = await jwtVerify(token, this.options.keys, {
        issuer: ACCESS_TOKEN.issuer,
        audience: ACCESS_TOKEN.audience,
        typ: ACCESS_TOKEN.type,
        algorithms: [ACCESS_TOKEN.algorithm],
        clockTolerance: this.options.clockToleranceSeconds ?? 30,
        requiredClaims: ['sub', 'sid', 'exp', 'jti'],
      });
      claims = payload as unknown as AccessTokenClaims;
    } catch (error) {
      // Clés publiques impossibles à charger : panne d'identity, pas un jeton invalide (pas de 401 à tort).
      if (error instanceof AppError) throw error;
      if (error instanceof errors.JWTExpired) {
        throw AppError.unauthenticated('GATEWAY_TOKEN_EXPIRED', 'Votre session a expiré, reconnectez-vous.');
      }
      throw AppError.unauthenticated('GATEWAY_TOKEN_INVALID', 'Jeton invalide.');
    }
    if (claims.token_use !== 'access') {
      throw AppError.unauthenticated('GATEWAY_TOKEN_INVALID', 'Jeton invalide.');
    }
    return {
      user: {
        userId: claims.sub,
        sessionId: claims.sid,
        activeContext: claims.ctx ?? 'personal',
        roles: (claims.roles ?? []).map((role) => ({
          role: role.role,
          scopeType: role.scopeType,
          scopeId: role.scopeId ?? null,
        })),
        mfa: claims.mfa === true,
        ...(typeof claims.auth_time === 'number' ? { authTime: claims.auth_time } : {}),
      },
      clientId: claims.client_id,
      tokenId: claims.jti,
      expiresAt: claims.exp,
    };
  }
}
