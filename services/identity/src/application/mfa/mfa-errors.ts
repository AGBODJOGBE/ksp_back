import { AppError } from '@ksp/platform';

/** Erreurs de la double authentification (contrat identity.proto, AuthService). */
export const mfaErrors = {
  tokenInvalid: () =>
    AppError.unauthenticated(
      'IDENTITY_MFA_TOKEN_INVALID',
      'Cette étape de connexion a expiré, reconnectez-vous.',
    ),
  methodInvalid: () =>
    AppError.invalid('IDENTITY_MFA_METHOD_INVALID', 'Cette méthode de vérification est invalide.'),
  codeInvalid: (attemptsRemaining: number) =>
    AppError.invalid('IDENTITY_MFA_CODE_INVALID', 'Le code est incorrect.', { attemptsRemaining }),
  codeReused: (attemptsRemaining: number) =>
    AppError.invalid(
      'IDENTITY_MFA_CODE_REUSED',
      'Ce code a déjà servi : attendez le suivant dans votre application.',
      { attemptsRemaining },
    ),
  tooManyAttempts: () =>
    AppError.precondition(
      'IDENTITY_MFA_TOO_MANY_ATTEMPTS',
      'Trop de codes faux : reconnectez-vous pour recommencer.',
    ),
  enrollmentRequired: () =>
    AppError.precondition(
      'IDENTITY_MFA_ENROLLMENT_REQUIRED',
      "Configurez d'abord votre application d'authentification.",
    ),
  alreadyEnrolled: () =>
    AppError.precondition(
      'IDENTITY_MFA_ALREADY_ENROLLED',
      "Votre application d'authentification est déjà configurée.",
    ),
  enrollmentNotStarted: () =>
    AppError.precondition(
      'IDENTITY_MFA_ENROLLMENT_NOT_STARTED',
      "Commencez par afficher le QR code de l'application d'authentification.",
    ),
  backofficeForbidden: () =>
    AppError.forbidden('IDENTITY_BACKOFFICE_FORBIDDEN', "Ce compte n'a pas accès au back-office."),
  accountSuspended: () => AppError.forbidden('IDENTITY_ACCOUNT_SUSPENDED', 'Ce compte est suspendu.'),
};
