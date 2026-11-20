import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';

/**
 * Base jetable des tests d'intégration : un schéma neuf par fichier de test, migrations appliquées
 * dans l'ordre, client Prisma branché dessus (comme cleaning.database.int.spec.ts). Ignoré sans
 * TEST_DATABASE_URL (fourni en CI).
 */
export const databaseUrl = process.env.TEST_DATABASE_URL;
export const describeWithDatabase = databaseUrl ? describe : describe.skip;
/** Délai des crochets : migration complète et connexion. */
export const HOOK_TIMEOUT_MS = 60_000;

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
/** Clé du verrou consultatif des migrations de test (valeur arbitraire, propre à cleaning). */
const MIGRATION_LOCK = 54_054_001;

export interface TestDatabase {
  pool: Pool;
  prisma: PrismaService;
  close(): Promise<void>;
}

export async function openTestDatabase(prefix: string): Promise<TestDatabase> {
  const schema = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  // Les fichiers de test tournent en parallèle et l'extension btree_gist de la migration est commune
  // à la base : créée dans public si elle manque (jamais dans un schéma jetable, que DROP SCHEMA
  // emporterait avec elle), sous un verrou consultatif, un schéma migré à la fois.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    const extension = await client.query<{ schema: string }>(
      "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'btree_gist'",
    );
    const extensionSchema = extension.rows[0]?.schema ?? 'public';
    if (!extension.rows.length) await client.query('CREATE EXTENSION btree_gist WITH SCHEMA public');
    await client.query(`SET search_path TO ${schema}, ${extensionSchema}`);
    for (const migration of readdirSync(MIGRATIONS)
      .filter((name) => /^\d{4}_/.test(name))
      .sort()) {
      await client.query(readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8'));
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    client.release();
  }
  const url = new URL(databaseUrl as string);
  url.searchParams.set('schema', schema);
  process.env.DATABASE_URL = url.toString();
  const prisma = new PrismaService(new ReadinessRegistry());
  await prisma.$connect();
  return {
    pool,
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
  };
}
