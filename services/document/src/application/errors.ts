import { AppError } from '@ksp/platform';

/** Erreurs du service (contrat gRPC, en-tête de document.proto). Messages en français. */
export const DocumentErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('DOCUMENT_VALIDATION_FAILED', message, { field }),
  templateUnknown: () => AppError.notFound('DOCUMENT_TEMPLATE_UNKNOWN', 'Ce modèle de document est inconnu.'),
  variablesInvalid: (fields: readonly string[]) =>
    AppError.invalid(
      'DOCUMENT_VARIABLES_INVALID',
      'Les informations du document sont incomplètes ou invalides.',
      {
        fields: [...fields],
      },
    ),
  notFound: () => AppError.notFound('DOCUMENT_NOT_FOUND', 'Ce document est introuvable.'),
  signatureNotFound: () =>
    AppError.notFound('DOCUMENT_SIGNATURE_NOT_FOUND', 'Cette demande de signature est introuvable.'),
  callerForbidden: () =>
    AppError.forbidden(
      'DOCUMENT_CALLER_FORBIDDEN',
      "Ce service n'est pas autorisé à effectuer cette action.",
    ),
  signatureNotRequired: () =>
    AppError.precondition('DOCUMENT_SIGNATURE_NOT_REQUIRED', 'Ce document ne se signe pas.'),
  invalidStatus: (status: string) =>
    AppError.precondition('DOCUMENT_INVALID_STATUS', 'Cette action est impossible dans l’état du document.', {
      status,
    }),
  signatureClosed: (status: string) =>
    AppError.precondition(
      'DOCUMENT_SIGNATURE_CLOSED',
      status === 'signed'
        ? 'Ce document est déjà signé.'
        : status === 'expired'
          ? 'Cette demande de signature a expiré.'
          : 'Cette demande de signature a été annulée.',
      { status },
    ),
  /** Trop de codes faux : la demande est close (statut expired, ADR-050). */
  signatureLocked: () =>
    AppError.precondition(
      'DOCUMENT_SIGNATURE_CLOSED',
      'Trop de codes faux : cette demande de signature est close. Demandez-en une nouvelle à l’émetteur.',
      { status: 'expired', reason: 'too_many_attempts' },
    ),
  signerUnreachable: () =>
    AppError.precondition(
      'DOCUMENT_SIGNER_UNREACHABLE',
      'Le signataire ne peut pas être prévenu : aucun téléphone ni e-mail connu.',
    ),
  codeTooSoon: (retryAfterSeconds: number) =>
    AppError.rateLimited(
      'DOCUMENT_CODE_TOO_SOON',
      'Un code vient d’être envoyé. Patientez avant d’en demander un nouveau.',
      { retryAfterSeconds },
    ),
  codeLimitReached: (retryAfterSeconds: number) =>
    AppError.rateLimited(
      'DOCUMENT_CODE_LIMIT_REACHED',
      'Trop de codes ont été demandés. Réessayez plus tard.',
      { retryAfterSeconds },
    ),
  codeInvalid: (attemptsLeft: number) =>
    AppError.invalid(
      'DOCUMENT_CODE_INVALID',
      attemptsLeft > 0 ? 'Ce code est incorrect.' : 'Ce code est incorrect. Demandez un nouveau code.',
      { attemptsLeft },
    ),
  codeExpired: () =>
    AppError.precondition('DOCUMENT_CODE_EXPIRED', 'Aucun code valable : demandez un nouveau code.'),
  consentRequired: () =>
    AppError.invalid(
      'DOCUMENT_CONSENT_REQUIRED',
      'Confirmez avoir lu le document et en accepter le contenu avant de signer.',
    ),
  contentChanged: () =>
    AppError.precondition(
      'DOCUMENT_CONTENT_CHANGED',
      'Le document a été modifié depuis sa production : il ne peut pas être signé.',
    ),
  alreadyExists: () =>
    AppError.conflict(
      'DOCUMENT_ALREADY_EXISTS',
      'Cette clé d’idempotence a déjà servi pour une autre demande.',
    ),
  dependencyUnavailable: (dependency: string) =>
    AppError.unavailable(
      'DOCUMENT_DEPENDENCY_UNAVAILABLE',
      'Un service nécessaire est momentanément indisponible. Réessayez dans quelques instants.',
      { dependency },
    ),
};
