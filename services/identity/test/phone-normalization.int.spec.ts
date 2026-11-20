import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { NormalizePhonesUseCase } from '../src/application/maintenance/normalize-phones.use-case';
import { PrismaPhoneNormalizationStore } from '../src/infrastructure/maintenance/prisma-phone-normalization.store';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test d'intégration contre un vrai PostgreSQL : le script phones:normalize (ADR-063).
 * Ignoré si TEST_DATABASE_URL n'est pas défini (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

describeWithDatabase('PrismaPhoneNormalizationStore (PostgreSQL)', () => {
  const schema = `identity_phones_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let store: PrismaPhoneNormalizationStore;
  let seq = 0;
  const uuid = () => `0192f1c4-7a2b-7c3d-8e4f-${String(++seq).padStart(12, '0')}`;

  async function account(phone: string): Promise<{ userId: string; phoneId: string }> {
    const userId = uuid();
    const phoneId = uuid();
    await pool.query(`INSERT INTO users (id, status, updated_at) VALUES ($1, 'active', now())`, [userId]);
    await pool.query(
      `INSERT INTO user_phones (id, user_id, phone_e164, is_primary, verified_at) VALUES ($1, $2, $3, true, now())`,
      [phoneId, userId, phone],
    );
    return { userId, phoneId };
  }

  const numbers = async () =>
    (await pool.query('SELECT phone_e164 FROM user_phones ORDER BY id')).rows.map((row) => row.phone_e164);

  beforeAll(async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const migration of readdirSync(MIGRATIONS)
      .filter((name) => /^\d{4}_/.test(name))
      .sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, migration, 'migration.sql'), 'utf8'));
    }
    const url = new URL(databaseUrl as string);
    url.searchParams.set('schema', schema);
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService(new ReadinessRegistry());
    await prisma.$connect();
    store = new PrismaPhoneNormalizationStore(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
  });

  it('réécrit les numéros à 8 chiffres, idempotent, sans toucher aux autres', async () => {
    await account('+22997000101');
    await account('+2290197000102');
    await account('+33612345678');
    const useCase = new NormalizePhonesUseCase(store);

    const dryRun = await useCase.execute({ apply: false });
    expect(dryRun.changes).toHaveLength(1);
    expect(await numbers()).toEqual(['+22997000101', '+2290197000102', '+33612345678']);

    const first = await useCase.execute({ apply: true });
    expect(first.changes).toHaveLength(1);
    expect(await numbers()).toEqual(['+2290197000101', '+2290197000102', '+33612345678']);

    const second = await useCase.execute({ apply: true });
    expect(second).toMatchObject({ scanned: 3, alreadyNormalized: 3, changes: [], conflicts: [] });
  });

  it('refuse le doublon et le rapporte', async () => {
    const legacy = await account('+22997000101');
    const holder = await account('+2290197000101');
    const report = await new NormalizePhonesUseCase(store).execute({ apply: true });
    expect(report.conflicts).toEqual([
      expect.objectContaining({ phoneId: legacy.phoneId, holderUserId: holder.userId }),
    ]);
    expect(await numbers()).toEqual(['+22997000101', '+2290197000101']);
  });

  it('la contrainte d’unicité protège une réécriture concurrente', async () => {
    const legacy = await account('+22997000101');
    await account('+2290197000101');
    expect(await store.rewrite(legacy.phoneId, '+22997000101', '+2290197000101')).toBe('taken');
    expect(await store.rewrite(legacy.phoneId, '+22997000999', '+2290197000999')).toBe('changed');
  });
});
