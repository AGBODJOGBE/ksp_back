import { AppError } from '@ksp/platform';
import { z } from 'zod';
import { type Page } from '../../application/common/api.ports';

/**
 * Paramètres de chemin et de requête communs aux routes écrites à la main (identifiant, page, clé
 * d'idempotence), repris du contrat OpenAPI.
 */
const uuid = z.guid();
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export const commonParams = {
  id: uuid,
  page: z.strictObject({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: uuid.optional(),
  }),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
};

type Query = Record<string, unknown>;

/** Paramètre invalide : 400 GATEWAY_VALIDATION_FAILED, sans reprendre la valeur envoyée. */
export function parseParam<S extends z.ZodType>(schema: S, value: unknown, field: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw AppError.invalid('GATEWAY_VALIDATION_FAILED', 'La requête est invalide.', {
    fields: [{ field, reason: result.error.issues[0]?.code ?? 'invalid' }],
  });
}

export const pageFrom = (query: Query): Page =>
  parseParam(commonParams.page, { limit: query['limit'], cursor: query['cursor'] }, 'limit/cursor');
export const idFrom = (id: unknown) => parseParam(commonParams.id, id, 'id');
export const keyFrom = (key: unknown) => parseParam(commonParams.idempotencyKey, key, 'Idempotency-Key');
