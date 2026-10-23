/**
 * Contenu d'un jeton d'accès KSP (v1). Source de vérité : contracts/tokens/access-token.v1.schema.json.
 * Le test de contrat vérifie que ce type et le schéma restent alignés.
 */
export type AccessTokenClientId = 'web' | 'mobile' | 'backoffice';

export interface AccessTokenRoleClaim {
  role: string;
  scopeType: 'global' | 'domain' | 'org' | 'personal';
  scopeId?: string | null;
}

/** Méthodes d’authentification (RFC 8176) : code par téléphone, puis seconde étape. */
export type AccessTokenAuthMethod = 'otp' | 'mfa';

export interface AccessTokenClaims {
  iss: 'ksp-identity';
  aud: 'ksp-api';
  sub: string;
  client_id: AccessTokenClientId;
  iat: number;
  exp: number;
  jti: string;
  token_use: 'access';
  sid: string;
  ctx: string;
  roles: AccessTokenRoleClaim[];
  mfa: boolean;
  auth_time: number;
  /** Facultatif : absent des jetons émis avant son ajout. */
  amr?: AccessTokenAuthMethod[];
}

/** Valeurs fixes du profil de jeton d'accès. */
export const ACCESS_TOKEN = {
  issuer: 'ksp-identity',
  audience: 'ksp-api',
  type: 'at+jwt',
  algorithm: 'ES256',
} as const;
