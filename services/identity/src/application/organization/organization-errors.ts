import { AppError } from '@ksp/platform';
import {
  MAX_PENDING_REQUESTS,
  type OrganizationDecision,
  type OrganizationStatus,
} from '../../domain/organization/organization';

/** Erreurs des organisations (contrat identity.proto, OrganizationService et OrganizationAdminService). */
export const organizationErrors = {
  invalid: (field: 'legalName' | 'address' | 'ifu' | 'rccm' | 'reason', message: string) =>
    AppError.invalid('IDENTITY_ORGANIZATION_INVALID', message, { field }),
  notFound: () => AppError.notFound('IDENTITY_ORGANIZATION_NOT_FOUND', 'Organisation introuvable.'),
  forbidden: () =>
    AppError.forbidden(
      'IDENTITY_ORGANIZATION_FORBIDDEN',
      "Cette action est réservée à un administrateur de l'organisation.",
    ),
  alreadyExists: () =>
    AppError.conflict(
      'IDENTITY_ORGANIZATION_ALREADY_EXISTS',
      'Une organisation avec cet IFU est déjà enregistrée chez KSP. Contactez le service client.',
    ),
  tooManyPending: () =>
    AppError.precondition(
      'IDENTITY_ORGANIZATION_TOO_MANY_PENDING',
      `Vous avez déjà ${MAX_PENDING_REQUESTS} demandes en attente de validation.`,
      { maximum: MAX_PENDING_REQUESTS },
    ),
  notActive: (status: OrganizationStatus) =>
    AppError.precondition('IDENTITY_ORGANIZATION_NOT_ACTIVE', NOT_ACTIVE_MESSAGES[status], { status }),
  invalidTransition: (from: OrganizationStatus, action: OrganizationDecision) =>
    AppError.precondition(
      'IDENTITY_ORGANIZATION_INVALID_TRANSITION',
      "Cette décision n'est pas possible dans l'état actuel de l'organisation.",
      { from, action },
    ),
  contextForbidden: () =>
    AppError.forbidden(
      'IDENTITY_CONTEXT_FORBIDDEN',
      "Le back-office s'utilise dans le contexte personnel uniquement.",
    ),
  sessionRevoked: () =>
    AppError.unauthenticated('IDENTITY_SESSION_REVOKED', 'Cette session a été fermée, reconnectez-vous.'),
};

const NOT_ACTIVE_MESSAGES: Readonly<Record<OrganizationStatus, string>> = {
  pending_review: 'Cette organisation est en attente de validation par KSP.',
  active: 'Cette organisation est déjà validée.',
  rejected: 'La demande de création de cette organisation a été refusée.',
  suspended: 'Cette organisation est suspendue. Contactez le service client KSP.',
};
