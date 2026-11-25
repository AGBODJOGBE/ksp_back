import { AppError } from '@ksp/platform';

/**
 * Erreurs de l'accès du débiteur (en-tête de recovery.proto, ADR-061). Le lien et la session
 * répondent par les mêmes messages que la gateway, qui refuse déjà un jeton ou une session mal
 * formés : un appelant ne distingue jamais un jeton mal formé, inconnu, révoqué ou expiré.
 */
export const DebtorAccessErrors = {
  linkInvalid: () =>
    AppError.notFound('RECOVERY_DEBTOR_LINK_INVALID', 'Ce lien est introuvable ou n’est plus valable.'),
  sessionInvalid: () =>
    AppError.unauthenticated(
      'RECOVERY_DEBTOR_SESSION_INVALID',
      'Votre session a expiré : rouvrez le lien reçu par message.',
    ),
  codeInvalid: (attemptsLeft: number) =>
    AppError.invalid('RECOVERY_DEBTOR_CODE_INVALID', 'Le code est incorrect.', { attemptsLeft }),
  codeExpired: () =>
    AppError.precondition('RECOVERY_DEBTOR_CODE_EXPIRED', 'Aucun code valable : demandez un nouveau code.'),
  codeTooSoon: (retryAfterSeconds: number) =>
    AppError.rateLimited(
      'RECOVERY_DEBTOR_CODE_TOO_SOON',
      'Un code vient de vous être envoyé : patientez avant d’en demander un autre.',
      { retryAfterSeconds },
    ),
  locked: (retryAfterSeconds: number) =>
    AppError.rateLimited(
      'RECOVERY_DEBTOR_LOCKED',
      'Trop de codes faux : l’accès est bloqué pendant une heure.',
      { retryAfterSeconds },
    ),
  /** Émission d'un lien (appel interne) pour un débiteur qui n'est pas celui de ce dossier. */
  caseNotFound: () => AppError.notFound('RECOVERY_CASE_NOT_FOUND', 'Ce dossier est introuvable.'),
  /** Émission d'un lien pour un dossier qui n'est ni actif ni suspendu. */
  caseNotOpen: (status: string) =>
    AppError.precondition(
      'RECOVERY_INVALID_TRANSITION',
      'Le lien du débiteur ne s’émet que pour un dossier actif ou suspendu.',
      { status },
    ),
} as const;
