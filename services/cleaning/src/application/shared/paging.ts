import { CleaningErrors } from './errors';

/**
 * Pages des listes du catalogue (convention du contrat : limit, cursor opaque, sort, total). Le
 * catalogue est petit (quelques centaines d'éléments au plus) : la liste triée est lue en entier,
 * puis découpée ; le curseur opaque porte le rang du premier élément de la page suivante.
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

const encode = (offset: number) => Buffer.from(`o:${offset}`, 'utf8').toString('base64url');

export function parsePage(input: { limit?: number | undefined; cursor?: string | undefined }): PageRequest {
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw CleaningErrors.validation('limit', 'out_of_range');
  }
  if (!input.cursor) return { limit, offset: 0 };
  const match = /^o:(\d{1,9})$/.exec(Buffer.from(input.cursor, 'base64url').toString('utf8'));
  if (!match) throw CleaningErrors.validation('cursor', 'invalid_type');
  return { limit, offset: Number(match[1]) };
}

/** Tri demandé, parmi ceux du contrat ; vide : le premier. */
export function parseSort<T extends string>(value: string | undefined, allowed: readonly [T, ...T[]]): T {
  if (!value) return allowed[0];
  if (!(allowed as readonly string[]).includes(value))
    throw CleaningErrors.validation('sort', 'invalid_type');
  return value as T;
}

export function pageOf<T>(sorted: readonly T[], page: PageRequest): Page<T> {
  const items = sorted.slice(page.offset, page.offset + page.limit);
  const next = page.offset + page.limit;
  return { items, nextCursor: next < sorted.length ? encode(next) : null, total: sorted.length };
}
