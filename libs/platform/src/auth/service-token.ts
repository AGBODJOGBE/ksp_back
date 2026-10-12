import { type Metadata } from '@grpc/grpc-js';
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { METADATA_KEYS } from '../context/request-context';
import { AppError } from '../errors/app-error';

/** Fournit le jeton de service à joindre aux appels sortants (ADR-013). */
export interface ServiceTokenProvider {
  getToken(audience: string): Promise<string>;
}

export interface ServiceTokenVerifierOptions {
  /** Nom du service qui vérifie : seul un jeton émis pour lui est accepté. */
  audience: string;
  issuer: string;
  keys: JWTVerifyGetKey;
}

export const SERVICE_TOKEN_VERIFIER = Symbol('SERVICE_TOKEN_VERIFIER');

/**
 * Vérifie le jeton de service d'un appel entrant et renvoie le nom du service appelant.
 * Un service ne fait confiance au contexte utilisateur transmis (x-user-id, rôles…) que
 * si l'appel porte un jeton de service valide.
 */
export class ServiceTokenVerifier {
  constructor(private readonly options: ServiceTokenVerifierOptions) {}

  static fromJwksUrl(jwksUrl: string, audience: string, issuer: string): ServiceTokenVerifier {
    return new ServiceTokenVerifier({ audience, issuer, keys: createRemoteJWKSet(new URL(jwksUrl)) });
  }

  async verify(metadata: Metadata): Promise<string> {
    const header = metadata.get(METADATA_KEYS.authorization)[0]?.toString();
    if (!header?.startsWith('Bearer ')) {
      throw AppError.unauthenticated('SERVICE_TOKEN_MISSING', 'Appel entre services non authentifié.');
    }
    try {
      const { payload } = await jwtVerify(header.slice('Bearer '.length), this.options.keys, {
        audience: this.options.audience,
        issuer: this.options.issuer,
        algorithms: ['ES256'],
      });
      if (payload['token_use'] !== 'service' || typeof payload.sub !== 'string') {
        throw new Error('not a service token');
      }
      return payload.sub;
    } catch {
      throw AppError.unauthenticated('SERVICE_TOKEN_INVALID', 'Jeton de service invalide.');
    }
  }
}
