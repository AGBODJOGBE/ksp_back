import { AppError } from '@ksp/platform';
import { formatXof } from '../shared/errors';

/** Erreurs des dossiers et des imports (en-tête de recovery.proto). Messages en français. */
export const CaseErrors = {
  /** Dossier inconnu ou hors du périmètre de l'appelant : jamais d'indice sur son existence. */
  caseNotFound: () => AppError.notFound('RECOVERY_CASE_NOT_FOUND', 'Ce dossier est introuvable.'),
  importNotFound: () => AppError.notFound('RECOVERY_IMPORT_NOT_FOUND', 'Cet import est introuvable.'),
  invalidTransition: (status: string, message: string, stage: string | null = null) =>
    AppError.precondition('RECOVERY_INVALID_TRANSITION', message, {
      status,
      ...(stage ? { stage } : {}),
    }),
  /**
   * Modification concurrente (verrou optimiste) : le contrat n'a pas de code propre, l'action n'est
   * plus possible dans l'état lu ; le client recharge le dossier puis réessaie.
   */
  concurrentUpdate: (status: string) =>
    AppError.precondition(
      'RECOVERY_INVALID_TRANSITION',
      'Le dossier vient d’être modifié par ailleurs. Rechargez-le puis réessayez.',
      { status },
    ),
  mandateNotSigned: () =>
    AppError.precondition(
      'RECOVERY_MANDATE_NOT_SIGNED',
      'Le mandat doit être signé avant le paiement des frais de dossier.',
    ),
  insufficientFunds: (missing: number, balance: number | null) =>
    AppError.precondition(
      'RECOVERY_INSUFFICIENT_FUNDS',
      `Solde du portefeuille insuffisant : il manque ${formatXof(missing)}. Rechargez votre portefeuille puis réessayez avec la même clé.`,
      {
        missing: { amount: missing, currency: 'XOF' },
        ...(balance === null ? {} : { balance: { amount: balance, currency: 'XOF' } }),
      },
    ),
  importFileInvalid: (reason: string, message = 'Ce fichier ne suit pas le modèle de tableur.') =>
    AppError.invalid('RECOVERY_IMPORT_FILE_INVALID', message, { reason }),
  viewerForbidden: () =>
    AppError.forbidden(
      'AUTH_FORBIDDEN',
      'Votre rôle dans cette organisation ne permet que la consultation des dossiers.',
    ),
} as const;
