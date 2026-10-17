import { AppError } from '@ksp/platform';

/** Réponse des méthodes du contrat dont le cas d'usage n'est pas encore livré. */
export function notImplemented(method: string): Promise<never> {
  return Promise.reject(
    AppError.notImplemented('IDENTITY_NOT_IMPLEMENTED', `La méthode ${method} n'est pas encore disponible.`),
  );
}
