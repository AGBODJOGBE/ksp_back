/**
 * Nature d'une erreur, indépendante du transport. Chaque nature correspond à un statut gRPC,
 * que la gateway traduit ensuite en code HTTP (cahier des charges Gateway, partie 6).
 */
export type ErrorKind =
  | 'INVALID_ARGUMENT'
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FAILED_PRECONDITION'
  | 'RESOURCE_EXHAUSTED'
  | 'UNAVAILABLE'
  | 'DEADLINE_EXCEEDED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL';

export type ErrorDetails = Record<string, unknown>;

/**
 * Erreur applicative. `code` est stable et lisible par les fronts (forme SERVICE_RAISON,
 * par exemple IDENTITY_OTP_EXPIRED) ; `message` est destiné à l'utilisateur, en français.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
  }

  static invalid(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('INVALID_ARGUMENT', code, message, details);
  }
  static unauthenticated(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('UNAUTHENTICATED', code, message, details);
  }
  static forbidden(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('PERMISSION_DENIED', code, message, details);
  }
  static notFound(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('NOT_FOUND', code, message, details);
  }
  static conflict(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('CONFLICT', code, message, details);
  }
  static precondition(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('FAILED_PRECONDITION', code, message, details);
  }
  static rateLimited(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('RESOURCE_EXHAUSTED', code, message, details);
  }
  static unavailable(code: string, message: string, details?: ErrorDetails): AppError {
    return new AppError('UNAVAILABLE', code, message, details);
  }
  static notImplemented(code: string, message = 'Fonctionnalité pas encore disponible.'): AppError {
    return new AppError('NOT_IMPLEMENTED', code, message);
  }
}
