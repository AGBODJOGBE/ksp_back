import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { type Prisma } from '../../../prisma/generated';
import { type Changes } from '../../application/ports';

export type Tx = Prisma.TransactionClient;

/** Événements (outbox) et traces d'un changement, écrits dans la transaction de l'état. */
export async function writeChanges(tx: Tx, changes: Changes, ids: () => string): Promise<void> {
  for (const event of changes.events) {
    await appendToOutbox(
      tx as unknown as SqlExecutor,
      createEnvelope(event.type, event.payload as never, { producer: 'cleaning' }),
    );
  }
  if (changes.audit.length) {
    await tx.auditEntry.createMany({
      data: changes.audit.map((entry) => ({
        id: ids(),
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        at: entry.at,
        ...(entry.details ? { details: entry.details as Prisma.InputJsonValue } : {}),
      })),
    });
  }
}

/** Page par curseur : identifiants UUID v7 décroissants (les plus récents d'abord). */
export function pageArgs(page: { limit: number; cursor: string | null }) {
  return { take: page.limit + 1, orderBy: { id: 'desc' as const } };
}

export function cursorFilter(page: { cursor: string | null }) {
  return page.cursor ? { id: { lt: page.cursor } } : {};
}

export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
}

export const json = (value: unknown) => value as Prisma.InputJsonValue;
