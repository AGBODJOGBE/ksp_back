import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type StoredFile } from '../src/domain/stored-file';
import { PrismaFileRepository } from '../src/infrastructure/persistence/prisma-file.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL : migrations du service dans un schéma jetable, puis
 * changements d'état conditionnels, purge par lots et effacement d'un compte supprimé dans la même
 * transaction que l'inbox. Ignoré sans TEST_DATABASE_URL (fourni en CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const OWNER = '0192f1c4-0000-7000-8000-00000000c001';
const SUBJECT = { type: 'cleaning_intervention', id: '0192f1c4-0000-7000-8000-00000000b001' };

describeWithDatabase('dépôt file (PostgreSQL)', () => {
  const schema = `file_test_${Date.now()}`;
  const ids = new UuidV7Generator();
  let pool: Pool;
  let prisma: PrismaService;
  let files: PrismaFileRepository;

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
    files = new PrismaFileRepository(prisma);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  const draft = (overrides: Partial<StoredFile> = {}): StoredFile => {
    const id = ids.next();
    return {
      id,
      purpose: 'cleaning_intervention_photo',
      fileName: 'avant.png',
      contentType: 'image/png',
      sizeBytes: 2048,
      storageKey: `cleaning_intervention_photo/${id}`,
      status: 'pending',
      rejectionReason: null,
      ownerId: OWNER,
      subject: null,
      attachedBy: null,
      attachedAt: null,
      createdAt: new Date(),
      completedAt: null,
      deletedAt: null,
      deletionReason: null,
      eraseAfter: null,
      ...overrides,
    };
  };

  it('confirmation et rattachement conditionnels : une seule fois', async () => {
    const file = draft();
    await files.create(file);
    const now = new Date();
    const results = await Promise.all([
      files.complete(file.id, { status: 'available', completedAt: now }),
      files.complete(file.id, { status: 'available', completedAt: now }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const attach = () => files.attach(file.id, { subject: SUBJECT, attachedBy: 'cleaning', attachedAt: now });
    expect(await attach()).toBe(true);
    expect(await attach()).toBe(false);
    expect((await files.findById(file.id))?.subject).toEqual(SUBJECT);
    expect(
      (await files.listBySubject(SUBJECT, ['cleaning_intervention_photo'], 10)).map((f) => f.id),
    ).toEqual([file.id]);
    expect(await files.listBySubject(SUBJECT, ['recovery_evidence'], 10)).toEqual([]);
  });

  it('quotas, purge des envois non confirmés, effacement physique', async () => {
    const old = draft({
      ownerId: '0192f1c4-0000-7000-8000-00000000c009',
      createdAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const fresh = draft({ ownerId: old.ownerId });
    await files.create(old);
    await files.create(fresh);
    expect(await files.countPending(old.ownerId!)).toBe(2);
    expect(await files.declaredBytesSince(old.ownerId!, new Date(Date.now() - 86_400_000))).toBe(2048);

    const now = new Date();
    expect(
      await files.expirePending({ createdBefore: new Date(Date.now() - 86_400_000), now, limit: 100 }),
    ).toBe(1);
    expect((await files.findById(old.id))?.status).toBe('deleted');
    const due = await files.listToErase(new Date(now.getTime() + 1), 100);
    expect(due.map((f) => f.id)).toContain(old.id);
    await files.remove(old.id, new Date(now.getTime() + 1));
    expect(await files.findById(old.id)).toBeNull();
    expect(await files.findById(fresh.id)).not.toBeNull();
  });

  it('compte supprimé : effacement et détachement dans la transaction de l’inbox, idempotent', async () => {
    const owner = '0192f1c4-0000-7000-8000-00000000c010';
    const kept = draft({
      ownerId: owner,
      status: 'available',
      fileName: 'Koffi.png',
      subject: SUBJECT,
      attachedBy: 'cleaning',
      attachedAt: new Date(),
    });
    const avatar = draft({
      ownerId: owner,
      purpose: 'avatar',
      status: 'available',
      subject: { type: 'identity_user', id: owner },
    });
    const pending = draft({ ownerId: owner });
    for (const file of [kept, avatar, pending]) await files.create(file);
    const input = {
      eventId: '0192f1c4-0000-7000-8000-0000000e0001',
      consumer: 'file.identity.user.deleted',
      erasedPurposes: ['avatar'] as const,
      now: new Date(),
    };
    expect(await files.eraseAccount(owner, input)).toEqual({ status: 'processed', erased: 2, detached: 1 });
    expect(await files.eraseAccount(owner, input)).toEqual({ status: 'duplicate', erased: 0, detached: 0 });
    expect(await files.findById(kept.id)).toMatchObject({
      status: 'available',
      ownerId: null,
      fileName: `${kept.id}.png`,
    });
    expect(await files.findById(avatar.id)).toMatchObject({
      status: 'deleted',
      deletionReason: 'account_deleted',
    });
    expect((await files.findById(pending.id))?.status).toBe('deleted');
  });
});
