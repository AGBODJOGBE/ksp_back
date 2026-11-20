import { requireRecentMfa, requireUser } from '@ksp/platform';

/**
 * Contrôles d'accès du back-office, revérifiés par chaque cas d'usage (partie 16.3, UC-GW-03). La
 * gateway seule appelle ces méthodes (`@AllowedCallers('gateway')` sur les contrôleurs) et contrôle
 * la permission `cleaning.*` de la route. Le contexte gRPC transmis par la gateway porte le compte,
 * ses rôles et sa double authentification, mais pas ses permissions (RBAC dynamique d'identity) :
 * le service revérifie donc le compte et la double authentification, pas la permission elle-même.
 */
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

/** Membre du personnel connecté, double authentification de la session back-office (12 h). */
export function requireStaff(nowMs?: number): { userId: string } {
  const user = requireUser();
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return { userId: user.userId };
}
