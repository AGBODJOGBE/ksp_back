import { AppError, type GrpcCaller } from '@ksp/platform';
import { type Metadata } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import { DocumentErrors } from '../application/errors';

const AVAILABILITY = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED']);

/**
 * Appel d'un service dont document dépend (file, notification, identity) : une panne devient
 * DOCUMENT_DEPENDENCY_UNAVAILABLE (à réessayer) ; toute autre erreur inattendue devient une erreur
 * interne, sans transmettre le message d'un autre service. `passThrough` : codes métier attendus,
 * traités par l'appelant. Seuls le service, la méthode et le code sont journalisés.
 */
export async function callDependency<T>(
  caller: GrpcCaller,
  dependency: string,
  name: string,
  invoke: (metadata: Metadata) => Observable<T>,
  options: { idempotent?: boolean; deadlineMs?: number; passThrough?: readonly string[] } = {},
): Promise<T> {
  try {
    return await caller.call(name, invoke, options);
  } catch (error) {
    throw dependencyError(dependency, name, error, options.passThrough);
  }
}

const logger = new Logger('Dependencies');

export function dependencyError(
  dependency: string,
  name: string,
  error: unknown,
  passThrough: readonly string[] = [],
): AppError {
  const appError = error instanceof AppError ? error : null;
  if (appError && passThrough.includes(appError.code)) return appError;
  if (!appError || AVAILABILITY.has(appError.kind) || appError.kind === 'INTERNAL') {
    logger.warn(`${dependency}.${name} indisponible (${appError?.code ?? 'erreur réseau'})`);
    return DocumentErrors.dependencyUnavailable(dependency);
  }
  logger.error(`${dependency}.${name} : réponse inattendue ${appError.code}`);
  return new AppError('INTERNAL', 'DOCUMENT_INTERNAL_ERROR', 'Une erreur interne est survenue.');
}
