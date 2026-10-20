import { type AccessRequirement } from '../routing/route-manifest';

/** Ce que la gateway sait de l'appelant, tiré du jeton d'accès vérifié. */
export interface Caller {
  roles: readonly { role: string }[];
  mfa: boolean;
  /** Dernière authentification forte, en secondes depuis 1970. */
  authTime?: number;
}

export type AccessDecision =
  { allowed: true } | { allowed: false; reason: 'unauthenticated' | 'role_missing' | 'mfa_required' };

/**
 * Applique l'exigence d'accès d'une route (UC-GW-03). Ce contrôle ne remplace pas ceux du service :
 * il évite seulement de transmettre un appel voué à l'échec.
 */
export function checkAccess(
  requirement: AccessRequirement,
  caller: Caller | null,
  nowSeconds: number,
): AccessDecision {
  if (requirement.level !== 'authenticated') return { allowed: true };
  if (!caller) return { allowed: false, reason: 'unauthenticated' };
  if (requirement.anyRole?.length) {
    const held = new Set(caller.roles.map((claim) => claim.role));
    if (!requirement.anyRole.some((role) => held.has(role)))
      return { allowed: false, reason: 'role_missing' };
  }
  if (requirement.recentMfaSeconds !== undefined) {
    const fresh =
      caller.mfa &&
      caller.authTime !== undefined &&
      nowSeconds - caller.authTime <= requirement.recentMfaSeconds;
    if (!fresh) return { allowed: false, reason: 'mfa_required' };
  }
  return { allowed: true };
}
