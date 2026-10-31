import { AppError, currentContext, hasRole, requireRecentMfa, requireUser } from '@ksp/platform';
import { type PayerScope } from '../../domain/amount-due';
import { type PaymentIntent } from '../../domain/payment-intent';
import { PaymentErrors } from './errors';

/**
 * Contrôles d'accès de payment. La gateway filtre déjà selon son manifeste ; le service revérifie
 * toujours (cahier des charges Gateway, UC-GW-03).
 */
export const PAYMENT_STAFF = ['finance_officer', 'cleaning_admin', 'super_admin'] as const;

/** Double authentification faite pendant la session back-office en cours (12 heures au plus). */
export const BACKOFFICE_MFA_MAX_AGE_SECONDS = 12 * 3600;

/** Payeur connecté : son organisation active, sinon lui-même. */
export function currentPayer(): PayerScope {
  const user = requireUser();
  const organizationId = user.activeContext && user.activeContext !== 'personal' ? user.activeContext : null;
  return { userId: user.userId, organizationId };
}

/**
 * Paiement visible : par son payeur, et par les membres de l'organisation payeuse dans son
 * contexte. Hors périmètre : 404, sans révéler l'existence du paiement.
 */
export function isVisibleTo(intent: PaymentIntent, payer: PayerScope): boolean {
  return (
    intent.customerId === payer.userId ||
    (intent.organizationId !== null && intent.organizationId === payer.organizationId)
  );
}

export function requireStaff(allowed: readonly string[], nowMs?: number): { userId: string } {
  const user = requireUser();
  if (!allowed.some((role) => hasRole(user, role))) {
    throw AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action.");
  }
  requireRecentMfa(BACKOFFICE_MFA_MAX_AGE_SECONDS, nowMs);
  return { userId: user.userId };
}

/**
 * Méthode réservée à certains services (jeton de service vérifié par le kit). Sans vérificateur
 * (développement), l'appelant n'est pas connu et l'appel passe.
 */
export function requireCaller(allowed: readonly string[]): void {
  const caller = currentContext()?.callerService;
  if (caller && !allowed.includes(caller)) throw PaymentErrors.callerForbidden();
}
