import { requireCaller, requireRecentMfa, requireUser } from '@ksp/platform';

/**
 * Contrôles d'accès des méthodes de l'espace connecté et du back-office. Seule la gateway les
 * appelle (ADR-050) : elle vérifie la permission de la route (cleaning.agent.manage,
 * cleaning.planning.manage, cleaning.session.perform) d'après le jeton d'accès. Le contexte
 * utilisateur que le kit transmet ne porte que les rôles, pas les permissions : le service
 * revérifie l'appelant, la connexion et, au back-office, la double authentification.
 */
export const GATEWAY_CALLERS = ['gateway'] as const;

/** Double authentification exigée au back-office : faite pendant la session (12 heures au plus). */
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

/** Compte connecté de l'espace agent ; renvoie son identifiant. */
export function requireConnectedUser(): string {
  requireCaller(GATEWAY_CALLERS);
  return requireUser().userId;
}

/** Membre du back-office, double authentification récente ; renvoie son compte. */
export function requireStaff(nowMs?: number): string {
  requireCaller(GATEWAY_CALLERS);
  const user = requireUser();
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return user.userId;
}
