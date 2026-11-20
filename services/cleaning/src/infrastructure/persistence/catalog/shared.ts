import { type Prisma } from '../../../../prisma/generated';
import { type Changes, type IdGenerator } from '../../../application/ports';
import { type PrismaService } from '../../prisma/prisma.service';
import { translateUniqueViolation, writeChanges } from '../changes';

/** Identifiant UUID : un autre identifiant ne désigne aucune ligne (colonnes uuid de PostgreSQL). */
export const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Texte facultatif : chaîne vide en base (colonnes NOT NULL), null pour l'application. */
export const optional = (value: string) => (value.length ? value : null);

/**
 * Écriture du catalogue : changements (clé d'idempotence, audit, événements) puis état, dans une
 * seule transaction ; une unicité violée devient DuplicateKeyError (`codeColumns` : code déjà pris).
 */
export async function transact(
  prisma: PrismaService,
  ids: IdGenerator,
  changes: Changes,
  apply: (tx: Prisma.TransactionClient) => Promise<unknown>,
  codeColumns: readonly string[] = ['code'],
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await writeChanges(tx, changes, () => ids.next());
      await apply(tx);
    });
  } catch (error) {
    throw translateUniqueViolation(error, codeColumns);
  }
}
