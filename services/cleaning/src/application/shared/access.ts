import { AppError, hasRole, requireRecentMfa, requireUser, type UserContext } from '@ksp/platform';
import { type CustomerKind } from '../../domain/quote-request';

/**
 * Contrôles d'accès du service. La gateway filtre déjà selon son manifeste, mais le service
 * revérifie toujours (cahier des charges Gateway, UC-GW-03) : client propriétaire, agent
 * affecté, rôles du back-office avec double authentification.
 */
export const ROLES = {
  supervisor: 'cleaning_supervisor',
  agent: 'cleaning_agent',
  admin: 'cleaning_admin',
} as const;

/**
 * Double authentification exigée sur le back-office : faite pendant la session en cours, soit
 * au plus 12 heures (durée d'une session back-office, cahier des charges Identité).
 */
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

export interface Customer {
  userId: string;
  kind: CustomerKind;
  organizationId: string | null;
}

/** Client connecté ; une organisation active (UC-ID-15) en fait un client entreprise. */
export function currentCustomer(): Customer {
  const user = requireUser();
  const organizationId = user.activeContext && user.activeContext !== 'personal' ? user.activeContext : null;
  return { userId: user.userId, kind: organizationId ? 'business' : 'individual', organizationId };
}

export type BackofficeRole = (typeof ROLES)[keyof typeof ROLES];

export interface Staff {
  userId: string;
  isSupervisor: boolean;
  isAdmin: boolean;
  isAgent: boolean;
}

/** Membre du back-office ayant au moins un des rôles, avec double authentification récente. */
export function requireStaff(allowed: readonly BackofficeRole[], nowMs?: number): Staff {
  const user: UserContext = requireUser();
  if (!allowed.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return {
    userId: user.userId,
    isSupervisor: hasRole(user, ROLES.supervisor),
    isAdmin: hasRole(user, ROLES.admin),
    isAgent: hasRole(user, ROLES.agent),
  };
}

export const SUPERVISION = [ROLES.supervisor, ROLES.admin] as const;
export const FIELD_WORK = [ROLES.supervisor, ROLES.admin, ROLES.agent] as const;
export const ADMINISTRATION = [ROLES.admin] as const;

/** Superviseur ou admin : tout le périmètre ; agent seul : ses passages uniquement. */
export function seesEverything(staff: Staff): boolean {
  return staff.isSupervisor || staff.isAdmin;
}
