import { AppError, currentContext, hasRole, requireRecentMfa, requireUser } from '@ksp/platform';
import { BillingErrors } from './errors';

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

/**
 * Méthode réservée à certains services : l'appelant est authentifié par son jeton de service,
 * vérifié par le kit. Sans vérificateur (développement local), il n'est pas connu et l'appel passe ;
 * en production, le jeton de service est obligatoire.
 */
export function requireCaller(allowed: readonly string[]): void {
  const caller = currentContext()?.callerService;
  if (caller && !allowed.includes(caller)) throw BillingErrors.callerForbidden();
}

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

/** Membres d'une organisation qui peuvent payer depuis son portefeuille ; org_viewer : lecture seule. */
const ORGANIZATION_PAYERS = ['org_admin', 'org_member'] as const;

/**
 * Client qui paie (ADR-046) : lui-même, ou son organisation active s'il y est org_admin ou
 * org_member (rôle de portée org du jeton, ADR-027).
 */
export function currentPayer(): CustomerScope {
  const scope = currentCustomer();
  const user = requireUser();
  const organizationId = scope.organizationId;
  if (
    organizationId &&
    !ORGANIZATION_PAYERS.some((role) => hasRole(user, role, { type: 'org', id: organizationId }))
  ) {
    throw AppError.forbidden(
      'AUTH_FORBIDDEN',
      'Votre rôle dans cette organisation ne permet pas de payer ses factures.',
    );
  }
  return scope;
}

export function requireStaff(allowed: readonly string[], nowMs?: number): { userId: string } {
  const user = requireUser();
  if (!allowed.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return { userId: user.userId };
}
