import { type PageRequest } from '../ports';
import { BillingErrors } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function requireUuid(field: string, value: string): string {
  if (!UUID.test(value)) throw BillingErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

/** Identifiant facultatif : chaîne vide = absent. */
export function optionalUuid(field: string, value: string | undefined): string | undefined {
  return value ? requireUuid(field, value) : undefined;
}

export function optionalText(field: string, value: string | undefined, max: number): string | null {
  const text = (value ?? '').trim();
  if (text.length > max) throw BillingErrors.invalid(field, `${max} caractères au plus.`);
  return text || null;
}

export function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw BillingErrors.invalid(field);
  return value as T;
}

export function parsePage(page: { limit?: number; cursor?: string } | undefined): PageRequest {
  const limit = page?.limit
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(page.limit)))
    : DEFAULT_PAGE_SIZE;
  const cursor = page?.cursor ? requireUuid('cursor', page.cursor) : null;
  return { limit, cursor };
}
