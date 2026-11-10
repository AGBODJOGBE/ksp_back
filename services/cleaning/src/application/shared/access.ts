import {
  AppError,
  currentContext,
  hasRole,
  requireRecentMfa,
  requireUser,
  type UserContext,
} from '@ksp/platform';
import { type CustomerKind } from '../../domain/quote-request';
import { CleaningErrors } from './errors';

/**
 * Contrôles d'accès du service. La gateway filtre déjà selon son manifeste, mais le service
 * revérifie toujours (cahier des charges Gateway, UC-GW-03) : client propriétaire, agent
 * affecté, rôles du back-office avec double authentification.
 *
 * `super_admin` (direction KSP) a partout la portée de `cleaning_admin`, comme pour la
 * facturation : il voit et pilote tout le Nettoyage.
 */
export const ROLES = {
  supervisor: 'cleaning_supervisor',
  agent: 'cleaning_agent',
  admin: 'cleaning_admin',
  superAdmin: 'super_admin',
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

/**
 * Méthode réservée à certains services : l'appelant est authentifié par son jeton de service,
 * vérifié par le kit. Sans vérificateur (développement local), il n'est pas connu et l'appel passe ;
 * en production, le jeton de service est obligatoire.
 */
export function requireCaller(allowed: readonly string[]): void {
  const caller = currentContext()?.callerService;
  if (caller && !allowed.includes(caller)) throw CleaningErrors.callerForbidden();
}

/**
 * Méthodes du client, du back-office et du catalogue public (ADR-049) : seule la gateway les appelle.
 * Le contexte utilisateur qu'elle transmet n'est cru que d'elle ; un autre service est refusé
 * (CLEANING_CALLER_FORBIDDEN). Les méthodes internes gardent leurs appelants (identity, payment, wallet).
 */
export const GATEWAY_CALLERS = ['gateway'] as const;

/** Client connecté (relayé par la gateway) ; une organisation active (UC-ID-15) le fait entreprise. */
export function currentCustomer(): Customer {
  requireCaller(GATEWAY_CALLERS);
  const user = requireUser();
  const organizationId = user.activeContext && user.activeContext !== 'personal' ? user.activeContext : null;
  return { userId: user.userId, kind: organizationId ? 'business' : 'individual', organizationId };
}

export type BackofficeRole = (typeof ROLES)[keyof typeof ROLES];

export interface Staff {
  userId: string;
  isSupervisor: boolean;
  /** cleaning_admin ou super_admin : même portée. */
  isAdmin: boolean;
  isAgent: boolean;
}

/** Membre du back-office (relayé par la gateway) ayant un des rôles, double authentification récente. */
export function requireStaff(allowed: readonly BackofficeRole[], nowMs?: number): Staff {
  requireCaller(GATEWAY_CALLERS);
  const user: UserContext = requireUser();
  if (!allowed.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return {
    userId: user.userId,
    isSupervisor: hasRole(user, ROLES.supervisor),
    isAdmin: hasRole(user, ROLES.admin) || hasRole(user, ROLES.superAdmin),
    isAgent: hasRole(user, ROLES.agent),
  };
}

export const SUPERVISION = [ROLES.supervisor, ROLES.admin, ROLES.superAdmin] as const;
export const FIELD_WORK = [ROLES.supervisor, ROLES.admin, ROLES.agent, ROLES.superAdmin] as const;
export const ADMINISTRATION = [ROLES.admin, ROLES.superAdmin] as const;

/** Superviseur ou admin : tout le périmètre ; agent seul : ses passages uniquement. */
export function seesEverything(staff: Staff): boolean {
  return staff.isSupervisor || staff.isAdmin;
}
