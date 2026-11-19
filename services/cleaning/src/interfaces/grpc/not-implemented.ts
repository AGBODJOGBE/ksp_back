import { AppError } from '@ksp/platform';

/**
 * Réponse des méthodes du contrat dont le cas d'usage n'est pas encore livré : statut gRPC
 * UNIMPLEMENTED (501 à la gateway). Le métier v2 arrive lot par lot (ADR-054).
 */
export function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    AppError.notImplemented('CLEANING_NOT_IMPLEMENTED', `La méthode ${method} n'est pas encore disponible.`),
  );
}
