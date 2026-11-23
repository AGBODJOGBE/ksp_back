import { AppError } from '@ksp/platform';
import { type z } from 'zod';
import { parseParam } from './params';
import { recoveryParams } from './recovery-schemas';

export { idFrom, keyFrom } from './params';

export type QueryParams = Record<string, unknown>;

export const rowFrom = (row: unknown) => parseParam(recoveryParams.row, row, 'row');
export const yearFrom = (year: unknown) => parseParam(recoveryParams.year, year, 'year');

/** Jeton du lien du débiteur : mal formé, introuvable comme un jeton inconnu (ADR-061, aucun indice). */
export function tokenFrom(token: unknown): string {
  const result = recoveryParams.token.safeParse(token);
  if (!result.success) {
    throw AppError.notFound('RECOVERY_DEBTOR_LINK_INVALID', 'Ce lien est introuvable ou n’est plus valable.');
  }
  return result.data;
}

/** Session du débiteur (en-tête X-Debtor-Session) : absente ou mal formée, 401 sans appeler recovery. */
export function sessionFrom(session: unknown): string {
  const result = recoveryParams.token.safeParse(session);
  if (!result.success) {
    throw AppError.unauthenticated(
      'RECOVERY_DEBTOR_SESSION_INVALID',
      'Votre session a expiré : rouvrez le lien reçu par message.',
    );
  }
  return result.data;
}

/** Paramètres de requête d'une liste ; un paramètre inconnu est ignoré. */
export function queryFrom<S extends z.ZodType>(schema: S, query: QueryParams): z.infer<S> {
  return parseParam(schema, query, 'query');
}
