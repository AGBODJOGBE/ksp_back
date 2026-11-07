import { AppError } from '@ksp/platform';
import { type ContentType } from '../../domain/purposes';
import { type RejectionReason } from '../../domain/stored-file';

const REJECTIONS: Record<RejectionReason, string> = {
  size_mismatch: 'La taille du fichier reçu ne correspond pas à la taille annoncée.',
  type_mismatch: 'Le contenu du fichier ne correspond pas au type annoncé.',
  malware: 'Le fichier a été refusé par l’analyse antivirus.',
};

/** Erreurs du service (contrat gRPC, en-tête de file.proto). Messages en français. */
export const FileErrors = {
  invalid: (field: string, message = 'La requête est invalide.') =>
    AppError.invalid('FILE_VALIDATION_FAILED', message, { field }),
  typeNotAllowed: (allowed: readonly ContentType[]) =>
    AppError.invalid('FILE_TYPE_NOT_ALLOWED', 'Ce type de fichier n’est pas accepté ici.', {
      allowed: [...allowed],
    }),
  tooLarge: (maxBytes: number) =>
    AppError.invalid('FILE_TOO_LARGE', 'Le fichier est trop volumineux.', { maxBytes }),
  notFound: () => AppError.notFound('FILE_NOT_FOUND', 'Ce fichier est introuvable.'),
  purposeForbidden: () =>
    AppError.forbidden('FILE_PURPOSE_FORBIDDEN', 'Vous ne pouvez pas envoyer de fichier pour cet usage.'),
  ownerMismatch: () =>
    AppError.forbidden('FILE_OWNER_MISMATCH', 'Ce fichier a été envoyé par un autre compte.'),
  callerForbidden: () =>
    AppError.forbidden('FILE_CALLER_FORBIDDEN', "Ce service n'est pas autorisé à appeler cette méthode."),
  quotaExceeded: (limit: 'pending_uploads' | 'daily_bytes', value: number) =>
    AppError.precondition(
      'FILE_QUOTA_EXCEEDED',
      limit === 'pending_uploads'
        ? 'Trop d’envois sont en cours : terminez-les avant d’en commencer d’autres.'
        : 'Vous avez atteint le volume d’envoi autorisé pour aujourd’hui.',
      { limit, value },
    ),
  notUploaded: () =>
    AppError.precondition(
      'FILE_NOT_UPLOADED',
      'Le fichier n’a pas encore été reçu. Envoyez-le, puis confirmez de nouveau.',
    ),
  uploadRejected: (reason: RejectionReason) =>
    AppError.precondition('FILE_UPLOAD_REJECTED', REJECTIONS[reason], { reason }),
  notAvailable: () => AppError.precondition('FILE_NOT_AVAILABLE', 'Ce fichier n’est pas disponible.'),
  alreadyAttached: () =>
    AppError.conflict('FILE_ALREADY_ATTACHED', 'Ce fichier est déjà rattaché à un autre objet.'),
  storageUnavailable: () =>
    AppError.unavailable(
      'FILE_STORAGE_UNAVAILABLE',
      'Le stockage des fichiers est momentanément indisponible. Réessayez dans quelques instants.',
    ),
};
