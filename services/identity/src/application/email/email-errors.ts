import { AppError } from '@ksp/platform';

/**
 * Erreurs de l'e-mail du profil. Le code lui-même suit les mêmes erreurs que les codes par
 * téléphone (IDENTITY_OTP_*) : les fronts les traitent de la même façon.
 */
export const emailErrors = {
  userNotFound: () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.'),
  invalid: () =>
    AppError.invalid('IDENTITY_EMAIL_INVALID', "L'adresse e-mail est invalide, par exemple nom@exemple.com."),
  undeliverable: () =>
    AppError.invalid('IDENTITY_EMAIL_INVALID', 'Cette adresse ne peut pas recevoir de code.'),
  alreadyVerified: () =>
    AppError.precondition(
      'IDENTITY_EMAIL_ALREADY_VERIFIED',
      "Cette adresse est déjà l'e-mail vérifié de votre compte.",
    ),
  alreadyUsed: () =>
    AppError.conflict('IDENTITY_EMAIL_ALREADY_USED', 'Cette adresse est déjà utilisée par un autre compte.'),
  rateLimited: (retryAfterSeconds: number) =>
    AppError.rateLimited(
      'IDENTITY_OTP_RATE_LIMITED',
      'Trop de codes demandés pour cette adresse ou ce compte. Réessayez plus tard.',
      { retryAfterSeconds },
    ),
  sendFailed: () =>
    AppError.unavailable(
      'IDENTITY_OTP_SEND_FAILED',
      "L'e-mail n'a pas pu être envoyé. Réessayez dans quelques instants.",
    ),
  expired: () => AppError.precondition('IDENTITY_OTP_EXPIRED', 'Le code a expiré, demandez-en un nouveau.'),
  exhausted: () =>
    AppError.precondition(
      'IDENTITY_OTP_TOO_MANY_ATTEMPTS',
      'Trop de codes faux : ce code est annulé, demandez-en un nouveau.',
    ),
  codeInvalid: (attemptsRemaining: number) =>
    AppError.invalid('IDENTITY_OTP_INVALID', 'Le code est incorrect.', { attemptsRemaining }),
};
