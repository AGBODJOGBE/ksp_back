import { createHash } from 'node:crypto';
import { cleaningErrors } from './errors';

/** Lecture des champs reçus : formats du contrat (UUID, ISO 8601 UTC, HH:MM, clés d'idempotence). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/** Longueur maximale d'un motif ou d'une note saisis. */
export const MAX_TEXT_LENGTH = 500;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function requireUuid(value: string | undefined | null, field: string): string {
  if (!value) throw cleaningErrors.invalid(field, 'required');
  if (!isUuid(value)) throw cleaningErrors.invalid(field, 'invalid_type');
  return value.toLowerCase();
}

export function idempotencyKey(value: string | undefined | null): string {
  if (!value) throw cleaningErrors.invalid('idempotencyKey', 'required', 'Clé d’idempotence obligatoire.');
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw cleaningErrors.invalid(
      'idempotencyKey',
      'invalid_type',
      'Clé d’idempotence invalide (8 à 100 caractères).',
    );
  }
  return value;
}

export function instant(value: string | undefined | null, field: string): Date {
  if (!value) throw cleaningErrors.invalid(field, 'required');
  const date = ISO_INSTANT.test(value) ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw cleaningErrors.invalid(field, 'invalid_type');
  return date;
}

export function optionalInstant(value: string | undefined | null, field: string): Date | null {
  return value ? instant(value, field) : null;
}

/** Période [début, fin) non vide. */
export function period(start: string | undefined, end: string | undefined, field = 'end') {
  const from = instant(start, 'start');
  const to = instant(end, 'end');
  if (to <= from) throw cleaningErrors.invalid(field, 'out_of_range', 'La fin doit suivre le début.');
  return { start: from, end: to };
}

/** "HH:MM" → minutes depuis minuit ; "24:00" vaut 1440 (fin de journée). */
export function minuteOfDay(value: string | undefined, field: string): number {
  if (!value || !HH_MM.test(value)) throw cleaningErrors.invalid(field, 'invalid_type');
  const [hours, minutes] = value.split(':').map(Number);
  return hours! * 60 + minutes!;
}

export function formatMinute(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** Motif ou texte saisi : sans espaces autour, 500 caractères au plus ; null s'il est vide. */
export function text(value: string | undefined | null, field: string): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length > MAX_TEXT_LENGTH) throw cleaningErrors.invalid(field, 'out_of_range');
  return trimmed || null;
}

export function requiredReason(value: string | undefined | null, field = 'reason'): string {
  const reason = text(value, field);
  if (!reason) throw cleaningErrors.reasonRequired(field);
  return reason;
}

/** Charge maximale reçue (heures entières, de 1 au plafond) ; absente : inchangée. */
export function hoursLimit(value: number | null | undefined, field: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw cleaningErrors.invalid(field, 'out_of_range');
  return value;
}

export interface PageRequest {
  limit: number;
  cursor: string | null;
}

/** Taille de page (20 par défaut, 100 au plus) ; un curseur illisible repart du début. */
export function page(
  limit: number | undefined,
  cursor: string | undefined,
  isCursor: (value: string) => boolean = isUuid,
): PageRequest {
  const size = limit && limit > 0 ? Math.min(limit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { limit: size, cursor: cursor && isCursor(cursor) ? cursor : null };
}

/** Curseur opaque d'une liste triée autrement que par identifiant : décalage dans la liste. */
export const isOffsetCursor = (value: string) => /^\d{1,6}$/.test(value);

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

/** Empreinte du contenu d'une requête idempotente : une même clé avec un autre contenu est refusée. */
export function requestHash(content: unknown): string {
  return createHash('sha256').update(stableJson(content)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
