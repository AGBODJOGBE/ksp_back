import {
  AppError,
  currentContext,
  hasRole,
  requireRecentMfa,
  requireUser,
  type UserContext,
} from '@ksp/platform';
import { RecoveryErrors } from './errors';

/**
 * Contrôles d'accès du service (ADR-060). La gateway filtre déjà selon son manifeste, mais le service
 * revérifie toujours (défense en profondeur, comme cleaning) : appelant, rôles du back-office et
 * ancienneté de la double authentification. Contrôle par rôles en attendant les permissions
 * d'ADR-057 : d'ici là, un superviseur voit tous les dossiers.
 */
export const ROLES = {
  agent: 'recovery_agent',
  supervisor: 'recovery_supervisor',
  legal: 'legal_officer',
  admin: 'recovery_admin',
  bailiff: 'recovery_bailiff',
  lawyer: 'recovery_lawyer',
  finance: 'finance_officer',
  superAdmin: 'super_admin',
} as const;

export type RecoveryRole = (typeof ROLES)[keyof typeof ROLES];

/** Double authentification de la session back-office en cours (12 heures). */
export const BACKOFFICE_MFA_SECONDS = 12 * 3600;
/** Actions sensibles : publier une règle tarifaire, modifier les réglages (moins de 10 minutes). */
export const CRITICAL_MFA_SECONDS = 600;

/** Groupes de rôles du manifeste de la gateway (recovery-routes.ts). */
export const CASE_READERS = [
  ROLES.agent,
  ROLES.supervisor,
  ROLES.legal,
  ROLES.admin,
  ROLES.superAdmin,
  ROLES.finance,
] as const;
export const PRICING_READERS = [ROLES.admin, ROLES.superAdmin, ROLES.finance] as const;
export const RECOVERY_ADMINS = [ROLES.admin, ROLES.superAdmin] as const;

/** Méthodes du créancier, du débiteur, du partenaire et du back-office : seule la gateway les appelle. */
export const GATEWAY_CALLERS = ['gateway'] as const;
/** Obligations avant la suppression d'un compte (UC-ID-11) : seul identity les demande. */
export const OBLIGATION_CALLERS = ['identity'] as const;

/**
 * Appelant authentifié par son jeton de service (vérifié par le kit). Sans vérificateur (développement
 * local), il n'est pas connu et l'appel passe ; en production, le jeton de service est obligatoire.
 */
export function requireCaller(allowed: readonly string[]): void {
  const caller = currentContext()?.callerService;
  if (caller && !allowed.includes(caller)) throw RecoveryErrors.callerForbidden();
}

export interface Staff {
  userId: string;
  roles: ReadonlySet<string>;
}

/** Membre du personnel (relayé par la gateway) ayant un des rôles, double authentification récente. */
export function requireStaff(
  allowed: readonly RecoveryRole[],
  mfaMaxAgeSeconds = BACKOFFICE_MFA_SECONDS,
  nowMs?: number,
): Staff {
  requireCaller(GATEWAY_CALLERS);
  const user: UserContext = requireUser();
  const held = allowed.filter((role) => hasRole(user, role));
  if (held.length === 0) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(mfaMaxAgeSeconds, nowMs);
  return { userId: user.userId, roles: new Set(held) };
}

/** Créancier connecté : son compte, ou son organisation active (ADR-027). */
export interface Creditor {
  userId: string;
  holder: { type: 'user' | 'organization'; id: string };
}

export function currentCreditor(): Creditor {
  requireCaller(GATEWAY_CALLERS);
  const user = requireUser();
  const organizationId = user.activeContext && user.activeContext !== 'personal' ? user.activeContext : null;
  return {
    userId: user.userId,
    holder: organizationId ? { type: 'organization', id: organizationId } : { type: 'user', id: user.userId },
  };
}
