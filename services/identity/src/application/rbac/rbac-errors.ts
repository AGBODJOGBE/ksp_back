import { AppError } from '@ksp/platform';

/** Erreurs du RBAC dynamique (contrat identity.proto, AccountAdminService et IdentityService ; ADR-057). */
export const rbacErrors = {
  roleInvalid: (field: 'code' | 'name' | 'description' | 'permissions' | 'zoneKeys') =>
    AppError.invalid('IDENTITY_ROLE_INVALID', 'Le rôle est invalide.', { field }),
  roleExists: () => AppError.conflict('IDENTITY_ROLE_ALREADY_EXISTS', 'Ce code de rôle est déjà pris.'),
  roleNotFound: () => AppError.notFound('IDENTITY_ROLE_NOT_FOUND', 'Ce rôle n’existe pas dans le catalogue.'),
  permissionNotFound: (codes: string[]) =>
    AppError.notFound('IDENTITY_PERMISSION_NOT_FOUND', 'Permission inconnue ou retirée.', { codes }),
  notEditable: () =>
    AppError.precondition(
      'IDENTITY_ROLE_NOT_EDITABLE',
      'Le rôle super administrateur ne se modifie pas et ne se désactive pas.',
    ),
  inactive: () =>
    AppError.precondition(
      'IDENTITY_ROLE_INACTIVE',
      'Ce rôle est désactivé : il ne s’attribue plus et ne se modifie plus.',
    ),
  inUse: (activeAssignments: number) =>
    AppError.precondition(
      'IDENTITY_ROLE_IN_USE',
      'Ce rôle est encore attribué : réaffectez ses titulaires avant de le désactiver.',
      { activeAssignments },
    ),
  catalogInvalid: (field: string) =>
    AppError.invalid('IDENTITY_CATALOG_INVALID', 'Le catalogue déclaré est invalide.', { field }),
  callerForbidden: () =>
    AppError.forbidden('IDENTITY_CALLER_FORBIDDEN', "Ce service n'est pas autorisé à faire cet appel."),
  reasonRequired: () =>
    AppError.invalid(
      'IDENTITY_ACCOUNT_ADMIN_INVALID',
      'Le motif est obligatoire (500 caractères au plus, sur une ligne).',
      { field: 'reason' },
    ),
};
