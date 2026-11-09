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

/** Texte obligatoire : espaces de début et de fin retirés, 1 à `max` caractères. */
export function requireText(field: string, value: string | undefined, max: number): string {
  const text = (value ?? '').trim();
  if (!text) throw PaymentErrors.invalid(field, 'Ce champ est obligatoire.');
  if (text.length > max) throw PaymentErrors.invalid(field, `${max} caractères au plus.`);
  return text;
}

/** Clé d'idempotence facultative : chaîne vide = absente ; sinon même format qu'à la création. */
export function optionalIdempotencyKey(value: string | undefined): string | null {
  if (!value) return null;
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw PaymentErrors.invalid('idempotencyKey', 'Clé d’idempotence invalide (8 à 100 caractères).');
  }
  return value;
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

/** Texte facultatif : espaces retirés, chaîne vide = absent, `max` caractères au plus. */
export function optionalText(field: string, value: string | undefined, max: number): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (text.length > max) throw PaymentErrors.invalid(field, `${max} caractères au plus.`);
  return text;
}

/** Montant XOF entier, entre 1 et `max` (ksp.common.v1.Money). */
export function requireXof(
  field: string,
  money: { amount: number; currency: string } | undefined,
  max: number,
): number {
  const amount = Number(money?.amount ?? 0);
  if ((money?.currency || 'XOF') !== 'XOF') throw PaymentErrors.invalid(field, 'Devise XOF attendue.');
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > max) {
    throw PaymentErrors.invalid(field, `Montant entier en XOF attendu, de 1 à ${max}.`);
  }
  return amount;
}

/** Date et heure ISO 8601 obligatoire. */
export function requireInstant(field: string, value: string | undefined): Date {
  const date = value ? new Date(value) : new Date(Number.NaN);
  if (!value || Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw PaymentErrors.invalid(field, 'Date et heure ISO 8601 attendues.');
  }
  return date;
}
