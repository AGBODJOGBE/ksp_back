/**
 * Jeton de service KSP (v1) et route d'émission (OAuth 2.0 client credentials, ADR-022).
 * Source de vérité : contracts/tokens/service-token.v1.schema.json.
 */
export interface ServiceTokenClaims {
  iss: 'ksp-identity';
  /** Service appelant. */
  sub: string;
  /** Service appelé. */
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  token_use: 'service';
}

/** Route d'émission sur le port HTTP interne d'identity (RFC 6749, section 4.4). */
export const SERVICE_TOKEN_ENDPOINT = {
  path: '/oauth/token',
  grantType: 'client_credentials',
} as const;

/** Réponse de /oauth/token en cas de succès (RFC 6749, section 5.1). */
export interface ServiceTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

/** Codes d'erreur de /oauth/token (RFC 6749, section 5.2 ; invalid_target : RFC 8707). */
export type ServiceTokenErrorCode =
  'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_target';
