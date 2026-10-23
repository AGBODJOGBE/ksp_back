import { type Recurrence, isValidRecurrence } from '../../domain/recurrence';
import { isValidSlot, type Slot } from '../../domain/schedule';
import { CleaningErrors } from './errors';

/** Lecture et contrôle des entrées : dates ISO 8601, entiers, textes bornés. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDate(field: string, value: string): Date {
  const date = ISO_DATE.test(value) ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw CleaningErrors.invalid(field, 'Date attendue au format ISO 8601.');
  return date;
}

export function parseSlot(field: string, slot: { start: string; end: string } | undefined): Slot {
  if (!slot) throw CleaningErrors.slotInvalid();
  const parsed = { start: parseDate(`${field}.start`, slot.start), end: parseDate(`${field}.end`, slot.end) };
  if (!isValidSlot(parsed)) throw CleaningErrors.slotInvalid('La fin du créneau doit suivre son début.');
  return parsed;
}

export function requireUuid(field: string, value: string): string {
  if (!UUID.test(value)) throw CleaningErrors.invalid(field, 'Identifiant invalide.');
  return value.toLowerCase();
}

export function requirePositiveInt(field: string, value: number, max = 1_000_000): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw CleaningErrors.invalid(field);
  return value;
}

/** Texte facultatif : nettoyé, null s'il est vide, refusé s'il dépasse la longueur maximale. */
export function optionalText(field: string, value: string | undefined, max: number): string | null {
  const text = (value ?? '').trim();
  if (text.length > max) throw CleaningErrors.invalid(field, `${max} caractères au plus.`);
  return text.length ? text : null;
}

export function requiredText(field: string, value: string | undefined, max: number): string {
  const text = optionalText(field, value, max);
  if (!text) throw CleaningErrors.invalid(field, 'Ce champ est obligatoire.');
  return text;
}

export function oneOf<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw CleaningErrors.invalid(field);
  return value as T;
}

/** Récurrence facultative : absente ou complète et cohérente. */
export function parseRecurrence(
  value: { period: string; visitsPerPeriod: number; durationMonths: number } | undefined,
): Recurrence | null {
  if (!value || !value.period) return null;
  const recurrence = value as Recurrence;
  if (!isValidRecurrence(recurrence)) throw CleaningErrors.invalid('recurrence');
  return {
    period: recurrence.period,
    visitsPerPeriod: recurrence.visitsPerPeriod,
    durationMonths: recurrence.durationMonths,
  };
}

export interface PageRequest {
  limit: number;
  cursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export function parsePage(page: { limit?: number; cursor?: string } | undefined): PageRequest {
  const limit = page?.limit
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(page.limit)))
    : DEFAULT_PAGE_SIZE;
  const cursor = page?.cursor ? requireUuid('cursor', page.cursor) : null;
  return { limit, cursor };
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}
