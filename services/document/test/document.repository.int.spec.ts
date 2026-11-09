import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type DocumentRecord } from '../src/domain/document';
import { type SignatureRequestRecord } from '../src/domain/signature';
import { PrismaDocumentRepository } from '../src/infrastructure/persistence/prisma-document.repository';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Intégration contre un vrai PostgreSQL : migrations du service dans un schéma jetable, numéros,
 * idempotence, une seule demande en attente par document, signature et outbox en une transaction,
 * clôture par lots, effacement d'un compte avec l'inbox. Ignoré sans TEST_DATABASE_URL (CI).
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const OWNER = '0192f1c4-0000-7000-8000-00000000c001';
const SIGNER = '0192f1c4-0000-7000-8000-00000000c002';
const SHA = 'a'.repeat(64);

describeWithDatabase('dépôt document (PostgreSQL)', () => {
  const schema = `document_test_${Date.now()}`;
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

  const now = new Date('2026-11-09T10:00:00.000Z');
  let sequence = 0;
  const draft = (overrides: Partial<DocumentRecord> = {}): DocumentRecord => {
    sequence += 1;
    return {
      id: ids.next(),
      template: 'recovery_settlement_agreement',
      templateVersion: 1,
      title: 'Protocole',
      number: `PAC-2026-${String(sequence).padStart(6, '0')}`,
      status: 'draft',
      subject: { type: 'recovery_case', id: 'REC-42' },
      ownerId: OWNER,
      producerService: 'recovery',
      idempotencyKey: `key-${sequence}`,
      fileId: ids.next(),
      sha256: SHA,
      sizeBytes: 2048,
      signedFileId: null,
      signedSha256: null,
      createdAt: now,
      signedAt: null,
      cancelledAt: null,
      cancellationReason: null,
      ...overrides,
    };
  };
  const pending = (
    documentId: string,
    overrides: Partial<SignatureRequestRecord> = {},
  ): SignatureRequestRecord => ({
    id: ids.next(),
    documentId,
    status: 'pending',
    signerUserId: null,
    signerPhoneE164: '+2290197000045',
    signerEmail: null,
    signerPhoneMasked: '+229********45',
    signerName: 'Koffi Mensah',
    tokenHash: `${ids.next()}-hash`,
    documentSha256: SHA,
    idempotencyKey: `sign-${ids.next()}`,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 3_600_000),
    signedAt: null,
    closedAt: null,
    ...overrides,
  });

  it('numéros sans doublon par préfixe et par année, même en parallèle', async () => {
    const numbers = await Promise.all(Array.from({ length: 10 }, () => documents.nextNumber('MAN', 2026)));
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await documents.nextNumber('MAN', 2027)).toBe(1);
  });

  it('idempotence par service : même clé refusée, retrouvée', async () => {
    const document = draft();
    expect(await documents.create(document)).toBe(true);
    expect(await documents.create({ ...draft(), idempotencyKey: document.idempotencyKey })).toBe(false);
    expect((await documents.findByIdempotencyKey('recovery', document.idempotencyKey))?.id).toBe(document.id);
    expect(await documents.findByIdempotencyKey('cleaning', document.idempotencyKey)).toBeNull();
  });

  it('une seule demande en attente par document ; retrait d’une demande non annoncée', async () => {
    const document = draft();
    await documents.create(document);
    const first = pending(document.id);
    expect(await documents.openRequest(first, ['draft', 'expired'])).toBe(true);
    expect((await documents.findById(document.id))?.status).toBe('pending_signature');
    expect(await documents.openRequest(pending(document.id), ['draft', 'expired'])).toBe(false);
    await documents.abortRequest(first.id, document.id, 'draft');
    expect(await documents.findRequestById(first.id)).toBeNull();
    expect((await documents.findById(document.id))?.status).toBe('draft');
  });

  it('signature : code consommé, preuve et événement en une transaction, une seule fois', async () => {
    const document = draft();
    await documents.create(document);
    const request = pending(document.id, { signerUserId: SIGNER });
    await documents.openRequest(request, ['draft']);
    const codeId = ids.next();
    await documents.createCode({
      id: codeId,
      requestId: request.id,
      codeHash: 'h',
      channel: 'whatsapp',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      attempts: 0,
      consumedAt: null,
    });
    expect(await documents.recordFailedAttempt(codeId)).toBe(1);
    expect((await documents.activeCode(request.id, now, 5))?.id).toBe(codeId);
    expect(await documents.activeCode(request.id, now, 1)).toBeNull();
    expect(await documents.codeSentDates(request.id, new Date(now.getTime() - 1000))).toHaveLength(1);

    const signedFileId = ids.next();
    const completion = {
      requestId: request.id,
      documentId: document.id,
      codeId,
      signedAt: now,
      signedFileId,
      signedSha256: 'b'.repeat(64),
      evidence: {
        id: ids.next(),
        requestId: request.id,
        documentId: document.id,
        signedAt: now,
        method: 'one_time_code' as const,
        channel: 'whatsapp' as const,
        codeId,
        signerUserId: SIGNER,
        signerName: 'Koffi Mensah',
        signerPhoneMasked: '+229********45',
        ip: '197.234.10.21',
        userAgent: 'Mozilla/5.0',
        documentSha256: SHA,
        signedFileId,
        signedSha256: 'b'.repeat(64),
        consent: true as const,
        certificateVersion: 1,
      },
      event: {
        documentId: document.id,
        signatureRequestId: request.id,
        template: document.template,
        templateVersion: 1,
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: 'REC-42',
        ownerId: OWNER,
        signerUserId: SIGNER,
        method: 'one_time_code' as const,
        channel: 'whatsapp' as const,
        documentSha256: SHA,
        signedFileId,
        signedDocumentSha256: 'b'.repeat(64),
        signedAt: now.toISOString(),
      },
    };
    const [a, b] = await Promise.all([
      documents.completeSignature(completion),
      documents.completeSignature({ ...completion, evidence: { ...completion.evidence, id: ids.next() } }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await documents.findById(document.id)).toMatchObject({ status: 'signed', signedFileId });
    expect(await documents.findRequestById(request.id)).toMatchObject({
      status: 'signed',
      signerPhoneE164: null,
    });
    const outbox = await pool.query(
      "SELECT payload FROM outbox WHERE event_type = 'document.signature.completed'",
    );
    expect(outbox.rows).toHaveLength(1);
    expect(JSON.stringify(outbox.rows[0].payload)).not.toContain('+2290197000045');
    expect(await documents.isSigner(document.id, SIGNER)).toBe(true);
    expect(await documents.cancelDocument(document.id, { reason: null, now })).toBe(false);
  });

  it('clôture des demandes expirées par lots : coordonnées effacées, document expiré', async () => {
    const document = draft();
    await documents.create(document);
    const request = pending(document.id, { expiresAt: new Date(now.getTime() - 1000) });
    await documents.openRequest(request, ['draft']);
    expect(await documents.expireDue(now, 100)).toBeGreaterThanOrEqual(1);
    expect(await documents.findRequestById(request.id)).toMatchObject({
      status: 'expired',
      signerPhoneE164: null,
      signerPhoneMasked: '+229********45',
    });
    expect((await documents.findById(document.id))?.status).toBe('expired');
    expect(await documents.expireRequest(request.id, now)).toBe(false);
  });

  it('compte supprimé : demandes en attente annulées, documents et preuves détachés, une seule fois', async () => {
    const owned = draft({ ownerId: SIGNER });
    await documents.create(owned);
    const request = pending(owned.id, { signerUserId: SIGNER, signerPhoneE164: null, tokenHash: null });
    await documents.openRequest(request, ['draft']);
    const result = await documents.eraseAccount(SIGNER, {
      eventId: ids.next(),
      consumer: 'document.identity.user.deleted',
      now,
    });
    expect(result.status).toBe('processed');
    expect(result.cancelledRequests).toBe(1);
    expect(result.detachedDocuments).toBeGreaterThanOrEqual(1);
    expect(await documents.findById(owned.id)).toMatchObject({ ownerId: null, status: 'draft' });
    expect(await documents.findRequestById(request.id)).toMatchObject({
      status: 'cancelled',
      signerUserId: null,
    });
    const evidence = await pool.query(
      'SELECT count(*)::int AS n FROM signature_evidence WHERE signer_user_id = $1',
      [SIGNER],
    );
    expect(evidence.rows[0].n).toBe(0);
    const eventId = ids.next();
    await documents.eraseAccount(OWNER, { eventId, consumer: 'document.identity.user.deleted', now });
    expect(
      (await documents.eraseAccount(OWNER, { eventId, consumer: 'document.identity.user.deleted', now }))
        .status,
    ).toBe('duplicate');
  });
});
