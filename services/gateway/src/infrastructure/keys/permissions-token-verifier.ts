import { type AccessTokenClaims } from '@ksp/contracts';
import { type VerifiedAccessToken } from '@ksp/platform';
import { decodeJwt } from 'jose';
import {
  type AccessTokenVerifierPort,
  type AuthenticatedCaller,
} from '../../application/access/access.ports';
import { type CallerPermissions } from '../../domain/access/access-policy';

/**
 * Vérification du jeton d'accès par le kit (signature ES256, émetteur, destinataire, expiration),
 * puis lecture de ses permissions (revendications perms et zone_perms, RBAC dynamique du cahier des
 * charges Nettoyage v2), que VerifiedAccessToken ne transporte pas. Le jeton n'est lu qu'une fois
 * sa signature vérifiée ; une permission mal formée est ignorée, jamais accordée.
 */
export class PermissionsTokenVerifier implements AccessTokenVerifierPort {
  constructor(private readonly verifier: { verify(token: string): Promise<VerifiedAccessToken> }) {}

  async verify(token: string): Promise<AuthenticatedCaller> {
    const verified = await this.verifier.verify(token);
    const claims = decodeJwt(token) as Partial<Pick<AccessTokenClaims, 'perms' | 'zone_perms'>>;
    return { ...verified, permissions: permissionsFrom(claims) };
  }
}

function permissionsFrom(
  claims: Partial<Pick<AccessTokenClaims, 'perms' | 'zone_perms'>>,
): CallerPermissions {
  const byZone: Record<string, readonly string[]> = {};
  const zones: unknown = claims.zone_perms;
  if (zones && typeof zones === 'object' && !Array.isArray(zones)) {
    for (const [zone, granted] of Object.entries(zones)) byZone[zone] = names(granted);
  }
  return { global: names(claims.perms), byZone };
}

/** Noms de permission d'une revendication ; absente (jeton émis avant son ajout) : aucune. */
function names(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
