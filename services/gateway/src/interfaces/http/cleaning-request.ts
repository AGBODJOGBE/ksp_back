import { AppError } from '@ksp/platform';
import { type z } from 'zod';
import { type CleaningCall } from '../../application/cleaning/cleaning.ports';
import { type CleaningOperationId } from '../../domain/routing/cleaning-routes';
import { CLEANING_REQUESTS } from './cleaning-schemas';
import { type FieldIssue, isEmptyBody, parseBody } from './schemas';

/** Validation d'une route du Nettoyage, produite depuis le contrat OpenAPI. */
export interface CleaningRequestSchema {
  params?: z.ZodType<Record<string, unknown>>;
  query?: z.ZodType<Record<string, unknown>>;
  body?: z.ZodType;
  /** Corps obligatoire ; sinon, absent ou vide, il n'est pas transmis. */
  bodyRequired?: boolean;
}

/** Requête telle qu'Express la lit : paramètres de chemin et de requête en texte, corps JSON. */
export interface RawCleaningRequest {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

/**
 * Paramètres de chemin, de requête et corps validés contre le schéma de la route ; refus : 400
 * GATEWAY_VALIDATION_FAILED avec les champs en cause (jamais leur valeur). Un corps envoyé à une route
 * qui n'en déclare pas est refusé, comme tout champ inconnu.
 */
export function parseCleaningRequest(
  operationId: CleaningOperationId,
  raw: RawCleaningRequest,
): Pick<CleaningCall, 'params' | 'query' | 'body'> {
  const schema: CleaningRequestSchema = CLEANING_REQUESTS[operationId];
  const params = schema.params ? parseParameters(schema.params, raw.params) : {};
  const query = schema.query ? parseParameters(schema.query, raw.query) : {};
  if (!schema.body) {
    if (!isEmptyBody(raw.body)) invalid([{ field: '(corps)', reason: 'unknown_field' }]);
    return { params, query };
  }
  if (!schema.bodyRequired && isEmptyBody(raw.body)) return { params, query };
  return { params, query, body: parseBody(schema.body, raw.body) as Record<string, unknown> };
}

function parseParameters(
  schema: z.ZodType<Record<string, unknown>>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  return invalid(
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(paramètres)',
      reason: issue.code,
    })),
  );
}

function invalid(fields: FieldIssue[]): never {
  throw AppError.invalid('GATEWAY_VALIDATION_FAILED', 'La requête est invalide.', { fields });
}
