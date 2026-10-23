import { AppError, hasRole, requireRecentMfa, requireUser } from '@ksp/platform';

/**
 * Contrôles d'accès de billing. La gateway filtre déjà selon son manifeste ; le service
 * revérifie toujours (cahier des charges Gateway, UC-GW-03).
 */
export const BILLING_STAFF = [
  'finance_officer',
  'cleaning_supervisor',
  'cleaning_admin',
  'super_admin',
] as const;
export const BILLING_SETTINGS_ADMINS = ['cleaning_admin', 'finance_officer', 'super_admin'] as const;

/** Double authentification faite pendant la session back-office en cours (12 heures au plus). */
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

/** Périmètre du client : son organisation active, sinon ses factures personnelles. */
export interface CustomerScope {
  userId: string;
  organizationId: string | null;
}

export function currentCustomer(): CustomerScope {
  const user = requireUser();
  const organizationId = user.activeContext && user.activeContext !== 'personal' ? user.activeContext : null;
  return { userId: user.userId, organizationId };
}

export function requireStaff(allowed: readonly string[], nowMs?: number): { userId: string } {
  const user = requireUser();
  if (!allowed.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return { userId: user.userId };
}
