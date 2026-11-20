import { AppError } from '@ksp/platform';

/**
 * Erreurs du contrat propres au lot G (planification automatique, réclamations, renouvellement),
 * avec la sorte gRPC du tableau du contrat. Les erreurs communes restent dans `errors.ts`.
 */
export const lotGErrors = {
  programNotFound: () => AppError.notFound('CLEANING_PROGRAM_NOT_FOUND', 'Programme introuvable.'),
  sessionNotFound: () => AppError.notFound('CLEANING_SESSION_NOT_FOUND', 'Séance introuvable.'),
  claimNotFound: () => AppError.notFound('CLEANING_CLAIM_NOT_FOUND', 'Réclamation introuvable.'),
  /** R-RC-01 : réclamation au-delà de la fenêtre après la séance ; details.windowHours. */
  claimWindowClosed: (windowHours: number) =>
    AppError.precondition(
      'CLEANING_CLAIM_WINDOW_CLOSED',
      'Le délai pour signaler un problème sur cette séance est dépassé.',
      { windowHours },
    ),
  /** R-RC-03 : l'auteur de la décision ne valide pas son propre crédit. */
  secondApproverRequired: () =>
    AppError.forbidden(
      'CLEANING_SECOND_APPROVER_REQUIRED',
      'Ce crédit doit être validé par une autre personne que l’auteur de la décision.',
    ),
  /** R-PG-07, R-PG-08 ; details.reason. */
  renewalNotAllowed: (reason: string) =>
    AppError.precondition(
      'CLEANING_RENEWAL_NOT_ALLOWED',
      'Ce programme ne peut pas être renouvelé ni commandé à nouveau.',
      { reason },
    ),
  forbidden: () =>
    AppError.forbidden('AUTH_FORBIDDEN', "Vous n'avez pas les droits nécessaires pour cette action."),
};
