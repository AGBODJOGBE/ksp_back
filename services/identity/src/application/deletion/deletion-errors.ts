import { AppError } from '@ksp/platform';
import { type DeletionObstacle, type SoleAdministeredOrganization } from '../../domain/user/account-deletion';

/** Erreurs de la suppression du compte (UC-ID-11, ADR-036). */
export const deletionErrors = {
  notFound: () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'),
  suspended: () => AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'Ce compte est suspendu.'),
  /** Compte gelé : seules la lecture du profil et l'annulation de la suppression restent possibles. */
  pending: () =>
    AppError.forbidden(
      'IDENTITY_ACCOUNT_DELETION_PENDING',
      'Votre compte est en cours de suppression : annulez la suppression pour le réutiliser.',
    ),
  internalAccount: () =>
    AppError.precondition(
      'IDENTITY_DELETION_INTERNAL_ACCOUNT',
      'Ce compte a un accès au back-office : sa suppression passe par un administrateur KSP.',
    ),
  lastOrgAdmin: (organizations: readonly SoleAdministeredOrganization[]) =>
    AppError.precondition(
      'IDENTITY_DELETION_LAST_ORG_ADMIN',
      "Vous êtes le seul administrateur d'un compte entreprise : nommez un autre administrateur ou contactez KSP.",
      { organizations: organizations.map((organization) => ({ ...organization })) },
    ),
  blocked: (obstacles: readonly DeletionObstacle[]) =>
    AppError.precondition(
      'IDENTITY_DELETION_BLOCKED',
      'Votre compte ne peut pas être supprimé tant que des opérations sont en cours.',
      { obligations: obstacles.map((obstacle) => ({ ...obstacle })) },
    ),
  unavailable: (services: readonly string[]) =>
    AppError.unavailable(
      'IDENTITY_DELETION_CHECK_UNAVAILABLE',
      'Nous ne pouvons pas vérifier votre compte pour le moment. Réessayez plus tard.',
      { services: [...services] },
    ),
  sessionRevoked: () =>
    AppError.unauthenticated('IDENTITY_SESSION_REVOKED', 'Cette session a été fermée, reconnectez-vous.'),
};
