import { AppError, hasRole, requireRecentMfa, requireUser } from '@ksp/platform';
import { type PageRequest } from './center.ports';

/**
 * Contrôles d'accès et validation du centre de notifications (ADR-039). La gateway filtre déjà
 * selon son manifeste ; le service revérifie toujours (cahier des charges Gateway, UC-GW-03).
 */

/** Rôles du back-office des notifications : direction et support client (catalogue d'identity). */
export const NOTIFICATION_STAFF = ['super_admin', 'support_agent'] as const;

/** Double authentification faite pendant la session back-office en cours (12 heures au plus). */
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CenterErrors = {
  invalid: (field: string, message = 'Valeur invalide.') =>
    AppError.invalid('NOTIFICATION_VALIDATION_FAILED', `La requête est invalide : ${field}. ${message}`, {
      field,
    }),
  notFound: () => AppError.notFound('NOTIFICATION_NOT_FOUND', 'Notification introuvable.'),
};

/** Utilisateur connecté (son identifiant en minuscules). */
export function currentUserId(): string {
  return requireUser().userId.toLowerCase();
}

/** Membre de l'équipe autorisé au back-office des notifications, double authentification récente. */
export function requireNotificationStaff(nowMs?: number): { userId: string } {
  const user = requireUser();
  if (!NOTIFICATION_STAFF.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return { userId: user.userId };
}

export function requireUuid(field: string, value: string): string {
  if (!UUID.test(value)) throw CenterErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

/** Identifiant facultatif : chaîne vide = absent. */
export function optionalUuid(field: string, value: string | undefined): string | null {
  return value ? requireUuid(field, value) : null;
}

export function parsePage(page: { limit?: number; cursor?: string } | undefined): PageRequest {
  const limit = page?.limit
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(page.limit)))
    : DEFAULT_PAGE_SIZE;
  const cursor = page?.cursor ? requireUuid('cursor', page.cursor) : null;
  return { limit, cursor };
}
