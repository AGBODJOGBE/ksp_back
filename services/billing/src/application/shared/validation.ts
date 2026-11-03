import { type PageRequest } from '../ports';
import { BillingErrors } from './errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Clé d'idempotence : 8 à 100 caractères, lettres, chiffres, « _ » et « - » (contrat OpenAPI). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

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

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Date facultative AAAA-MM-JJ (chaîne vide = absente), lue comme un jour civil au Bénin : renvoie
 * son numéro de jour (beninDay). Une date qui n'existe pas (2026-02-30) est refusée.
 */
export function optionalDay(field: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = DATE.exec(value);
  if (!match) throw BillingErrors.invalid(field, 'Date attendue au format AAAA-MM-JJ.');
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw BillingErrors.invalid(field, 'Cette date n’existe pas.');
  }
  return utc / 86_400_000;
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
