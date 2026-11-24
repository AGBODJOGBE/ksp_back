/**
 * Contenu d'un jeton d'accès KSP (v1). Source de vérité : contracts/tokens/access-token.v1.schema.json.
 * Le test de contrat vérifie que ce type et le schéma restent alignés.
 */
export type AccessTokenClientId = 'web' | 'mobile' | 'backoffice';

export interface AccessTokenRoleClaim {
  role: string;
  /** `zone` : attribution limitée à des communes (R-RB-03 du CDC Nettoyage v2). */
  scopeType: 'global' | 'domain' | 'org' | 'personal' | 'zone';
  scopeId?: string | null;
  /** Portée zone : clés des communes (référentiel de geo). */
  zoneKeys?: string[];
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
  /**
   * Permissions valables partout (v2, R-RB-05) : union des permissions des rôles actifs du contexte.
   * Facultatif : absent des jetons émis avant son ajout (liste vide).
   */
  perms?: string[];
  /** Permissions limitées à des zones (v2, R-RB-03) : clé de commune → permissions. */
  zone_perms?: Record<string, string[]>;
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

/**
 * Rôle d'une session restreinte : compte en cours de suppression (UC-ID-11, ADR-036). Il remplace
 * le rôle customer ; la gateway n'accepte un tel jeton que sur les routes qui l'autorisent
 * explicitement (lecture du profil, annulation de la suppression, déconnexion).
 */
export const ACCOUNT_DELETION_PENDING_ROLE = 'account_deletion_pending';
