import { appendToOutbox, createEnvelope, type SqlExecutor } from '@ksp/platform';
import { type Prisma } from '../../../prisma/generated';
import { type Changes, DuplicateKeyError } from '../../application/ports';

export type Tx = Prisma.TransactionClient;

/**
 * Événements (outbox), traces et clé d'idempotence d'un changement, écrits dans la transaction de
 * l'état. Les dépôts l'appellent avant d'écrire l'état : un rejeu concurrent de la même clé attend
 * la première transaction, puis échoue sur la clé (rejouée), jamais sur un code déjà pris.
 */
export async function writeChanges(tx: Tx, changes: Changes, ids: () => string): Promise<void> {
  if (changes.idempotency) {
    const record = changes.idempotency;
    await tx.idempotencyRecord.create({
      data: {
        actorId: record.actorId,
        operation: record.operation,
        idempotencyKey: record.key,
        requestHash: record.requestHash,
        response: record.response as Prisma.InputJsonValue,
        createdAt: record.at,
      },
    });
  }
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

/**
 * Unicité violée (Prisma P2002) traduite pour l'application : clé d'idempotence, code (colonnes
 * citées par `codeColumns`), sinon écriture concurrente. Toute autre erreur est rendue telle quelle.
 */
export function translateUniqueViolation(error: unknown, codeColumns: readonly string[] = []): unknown {
  const prismaError = error as { code?: unknown; meta?: { target?: unknown } } | null;
  if (prismaError?.code !== 'P2002') return error;
  const target = JSON.stringify(prismaError.meta?.target ?? '');
  if (target.includes('idempotency')) return new DuplicateKeyError('idempotency');
  if (codeColumns.some((column) => target.includes(column))) return new DuplicateKeyError('code');
  return new DuplicateKeyError('concurrent');
}
