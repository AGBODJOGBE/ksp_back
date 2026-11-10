import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { LinkSignatureUseCases } from '../src/application/signing.use-cases';
import { fakeDeps, FakeSecrets } from '../src/application/testing/fakes';
import { PrismaDocumentRepository } from '../src/infrastructure/persistence/prisma-document.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Codes de signature sous la concurrence, contre un vrai PostgreSQL (ADR-050) : des essais
 * simultanés ne comparent jamais plus de codes que le plafond, et des envois simultanés ne
 * dépassent pas les limites d'envoi. Ignoré sans TEST_DATABASE_URL (la CI le fournit).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const SHA = 'a'.repeat(64);
const CONCURRENT = 20;

const codeOf = (error: unknown) => (error instanceof AppError ? error.code : String(error));

/** Secrets qui comptent les comparaisons de codes. */
class CountingSecrets extends FakeSecrets {
  comparisons = 0;
  override codeMatches(codeId: string, code: string, codeHash: string) {
    this.comparisons += 1;
    return super.codeMatches(codeId, code, codeHash);
  }
}

describeWithDatabase('codes de signature sous la concurrence (PostgreSQL)', () => {
  const schema = `document_races_${Date.now()}`;
  const ids = new UuidV7Generator();
  let pool: Pool;
  let prisma: PrismaService;
  let documents: PrismaDocumentRepository;

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
    url.searchParams.set('connection_limit', '10');
    process.env.DATABASE_URL = url.toString();
    prisma = new PrismaService(new ReadinessRegistry());
    await prisma.$connect();
    documents = new PrismaDocumentRepository(prisma);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  /** Document en attente de signature par lien ; renvoie le jeton du lien et les dépendances. */
  async function pendingSignature() {
    const secrets = new CountingSecrets();
    const deps = { ...fakeDeps(), documents, secrets, ids };
    const now = new Date();
    deps.clock.current = now;
    const documentId = ids.next();
    await documents.create({
      id: documentId,
      template: 'recovery_settlement_agreement',
      templateVersion: 1,
      title: 'Protocole',
      number: `PAC-2026-${documentId.slice(-6)}`,
      status: 'draft',
      subject: { type: 'recovery_case', id: 'REC-42' },
      ownerId: null,
      producerService: 'recovery',
      idempotencyKey: documentId,
      fileId: ids.next(),
      sha256: SHA,
      sizeBytes: 2048,
      signedFileId: null,
      signedSha256: null,
      createdAt: now,
      signedAt: null,
      cancelledAt: null,
      cancellationReason: null,
    });
    const token = randomBytes(32).toString('base64url');
    const requestId = ids.next();
    await documents.openRequest(
      {
        id: requestId,
        documentId,
        status: 'pending',
        signerUserId: null,
        signerPhoneE164: '+2290197000045',
        signerEmail: null,
        signerPhoneMasked: '+229********45',
        signerName: 'Koffi Mensah',
        tokenHash: secrets.hashToken(token),
        documentSha256: SHA,
        idempotencyKey: requestId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
        signedAt: null,
        closedAt: null,
      },
      ['draft'],
    );
    return { deps, secrets, token, requestId, useCases: new LinkSignatureUseCases(deps) };
  }

  it('des essais simultanés ne comparent pas plus de codes que le plafond', async () => {
    const { deps, secrets, token, useCases } = await pendingSignature();
    secrets.nextCodes = ['482913'];
    await useCases.sendCode(token);

    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENT }, () => useCases.sign({ token, code: '000000', consent: true })),
    );

    expect(secrets.comparisons).toBe(deps.settings.codePolicy.maxAttempts);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    const { rows } = await pool.query('SELECT attempts FROM signature_codes');
    expect(rows.at(-1).attempts).toBe(deps.settings.codePolicy.maxAttempts);
  });

  it('des envois simultanés ne créent qu’un code', async () => {
    const { deps, token, requestId, useCases } = await pendingSignature();

    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => useCases.sendCode(token)));

    const sent = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(sent).toHaveLength(1);
    expect(
      outcomes.flatMap((outcome) => (outcome.status === 'rejected' ? [codeOf(outcome.reason)] : [])),
    ).toEqual(Array(9).fill('DOCUMENT_CODE_TOO_SOON'));
    expect(deps.notifier.codes).toHaveLength(1);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM signature_codes WHERE request_id = $1',
      [requestId],
    );
    expect(rows[0].n).toBe(1);
  });
});
