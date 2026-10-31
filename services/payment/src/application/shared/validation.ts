import { type PageRequest } from '../ports';
import { PaymentErrors } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Clé d'idempotence : 8 à 100 caractères, lettres, chiffres, « _ » et « - » (contrat OpenAPI). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function requireUuid(field: string, value: string): string {
  if (!UUID.test(value)) throw PaymentErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

/** Identifiant facultatif : chaîne vide = absent. */
export function optionalUuid(field: string, value: string | undefined): string | undefined {
  return value ? requireUuid(field, value) : undefined;
}

export function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw PaymentErrors.invalid(field);
  return value as T;
}

/** Valeur énumérée facultative : chaîne vide = absente. */
export function optionalOneOf<T extends string>(
  field: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return value ? oneOf(field, value, allowed) : undefined;
}

export function parsePage(page: { limit?: number; cursor?: string } | undefined): PageRequest {
  const limit = page?.limit
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(page.limit)))
    : DEFAULT_PAGE_SIZE;
  const cursor = page?.cursor ? requireUuid('cursor', page.cursor) : null;
  return { limit, cursor };
}
