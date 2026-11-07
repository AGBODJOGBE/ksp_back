import { AppError } from '@ksp/platform';
import { type AccountAction } from '../../domain/role/role-administration';

/** Erreurs de l'administration des comptes (contrat identity.proto, AccountAdminService, ADR-038). */
export const accountAdminErrors = {
  invalid: (field: 'query' | 'reason', message: string) =>
    AppError.invalid('IDENTITY_ACCOUNT_ADMIN_INVALID', message, { field }),
  reasonRequired: () =>
    accountAdminErrors.invalid('reason', 'Le motif est obligatoire (500 caractères au plus, sur une ligne).'),
  notFound: () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'),
  roleNotFound: () => AppError.notFound('IDENTITY_ROLE_NOT_FOUND', 'Ce rôle n’existe pas dans le catalogue.'),
  assignmentNotFound: () =>
    AppError.notFound(
      'IDENTITY_ROLE_ASSIGNMENT_NOT_FOUND',
      'Cette attribution est introuvable pour ce compte.',
    ),
  roleForbidden: () =>
    AppError.forbidden(
      'IDENTITY_ROLE_FORBIDDEN',
      'Ce rôle ne fait pas partie de ceux que vous pouvez gérer.',
    ),
  scopeInvalid: () =>
    AppError.invalid(
      'IDENTITY_ROLE_SCOPE_INVALID',
      'Ce rôle s’attribue dans une organisation ou au compte lui-même, pas depuis le back-office.',
    ),
  alreadyRevoked: () => AppError.precondition('IDENTITY_ROLE_ALREADY_REVOKED', 'Ce rôle a déjà été retiré.'),
  notActive: (status: string) =>
    AppError.precondition(
      'IDENTITY_ACCOUNT_NOT_ACTIVE',
      'Ce compte n’est pas actif : aucun rôle ne peut lui être attribué.',
      { status },
    ),
  invalidTransition: (from: string, action: AccountAction) =>
    AppError.precondition(
      'IDENTITY_ACCOUNT_INVALID_TRANSITION',
      'Cette action n’est pas possible dans l’état actuel du compte.',
      { from, action },
    ),
  lastSuperAdmin: () =>
    AppError.precondition(
      'IDENTITY_LAST_SUPER_ADMIN',
      'C’est le dernier super administrateur actif : nommez-en un autre avant.',
    ),
  selfAction: () =>
    AppError.precondition(
      'IDENTITY_SELF_ACTION_FORBIDDEN',
      'Cette action ne peut pas viser votre propre compte : demandez-la à un autre super administrateur.',
    ),
  mfaNotEnrolled: () =>
    AppError.precondition(
      'IDENTITY_MFA_NOT_ENROLLED',
      'Ce compte n’a pas de double authentification à réinitialiser.',
    ),
};
