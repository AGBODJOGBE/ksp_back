import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlindIndex, FieldCipher, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { disputeResponseId } from '../src/application/amicable/dispute-responses';
import { MemoryDocumentCancellation } from '../src/application/testing/amicable-fakes';
import {
  MemoryCreditorProfiles,
  MemoryDirectory,
  MemoryDocuments,
  MemoryFiles,
  MemorySpreadsheets,
  MemoryWallet,
} from '../src/application/testing/case-fakes';
import { caseInput, caseWorld, SUPERVISOR_ID } from '../src/application/testing/case-scenarios';
import { CapturingNotifier, FakeDebtorSecrets } from '../src/application/testing/debtor-access.fakes';
import { asCreditor, asService, asStaff, CREDITOR_ID, makeDeps, NOW } from '../src/application/testing/fakes';
import {
  MemoryDebtorUploads,
  MemoryDocumentUrls,
  MemoryPaymentLinks,
  MoneyWallet,
} from '../src/application/testing/money-fakes';
import { createUseCases } from '../src/application/use-cases';
import { PrismaAmicableStore } from '../src/infrastructure/persistence/prisma-amicable.store';
import { PrismaCaseImportRepository } from '../src/infrastructure/persistence/prisma-case-imports.repository';
import { PrismaCaseQueries } from '../src/infrastructure/persistence/prisma-case-queries';
import { PrismaCaseRepository } from '../src/infrastructure/persistence/prisma-cases.repository';
import { PrismaCreditorPreferencesStore } from '../src/infrastructure/persistence/prisma-creditor-preferences.store';
import { PrismaDebtorAccessJournal } from '../src/infrastructure/persistence/prisma-debtor-access.journal';
import {
  PrismaDebtorAccessStore,
  PrismaDebtorCaseReader,
} from '../src/infrastructure/persistence/prisma-debtor-access.stores';
import { PrismaMoneyStore } from '../src/infrastructure/persistence/prisma-money.store';
import { PrismaAuditLog } from '../src/infrastructure/persistence/prisma-settings.stores';
import { PrismaStatementStore } from '../src/infrastructure/persistence/prisma-statements.store';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { KitPersonalData } from '../src/infrastructure/security/kit-personal-data';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Compléments du recouvrement contre un vrai PostgreSQL : relevés mensuels (un par dossier et par mois,
 * facture de commission de billing rattachée avant ou après le relevé, inbox, liste paginée), décision
 * `dispute_response` (demande à l'ouverture, close à la résolution, index partiel d'une seule demande
 * ouverte), espace du débiteur en lecture seule après la clôture (liens bornés, date de clôture lue).
 * Schéma jetable ; ignoré sans TEST_DATABASE_URL.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const DAY_MS = 86_400_000;

describeWithDatabase('compléments du recouvrement (PostgreSQL)', () => {
  const schema = `recovery_complements_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let personal: KitPersonalData;
  const prepaid = new MemoryWallet();
  const paymentLinks = new MemoryPaymentLinks();
  const ids = new UuidV7Generator();

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
    personal = new KitPersonalData(
      FieldCipher.fromConfig(undefined, 'test', 'RECOVERY_PII_ENCRYPTION_KEYS'),
      BlindIndex.fromConfig(undefined, 'test', 'RECOVERY_BLIND_INDEX_KEYS'),
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  function world() {
    const directory = new MemoryDirectory();
    directory.users.set(CREDITOR_ID, 'Awa Créancière');
    const notifier = new CapturingNotifier();
    const secrets = new FakeDebtorSecrets();
    const deps = makeDeps({
      personalData: personal,
      cases: new PrismaCaseRepository(prisma, personal),
      caseQueries: new PrismaCaseQueries(prisma, personal),
      imports: new PrismaCaseImportRepository(prisma, personal),
      preferences: new PrismaCreditorPreferencesStore(prisma),
      audit: new PrismaAuditLog(prisma),
      wallet: new MoneyWallet(prepaid),
      documents: new MemoryDocuments(),
      files: new MemoryFiles(),
      directory,
      creditorProfiles: new MemoryCreditorProfiles(),
      spreadsheets: new MemorySpreadsheets(),
      paymentLinks,
      notifier,
      money: new PrismaMoneyStore(prisma, personal),
      amicable: new PrismaAmicableStore(prisma, personal),
      documentCancellation: new MemoryDocumentCancellation(),
      debtorUploads: new MemoryDebtorUploads(),
      documentUrls: new MemoryDocumentUrls(),
      statements: new PrismaStatementStore(prisma),
      ids,
      debtorAccess: {
        store: new PrismaDebtorAccessStore(prisma),
        reader: new PrismaDebtorCaseReader(prisma),
        journal: new PrismaDebtorAccessJournal(prisma),
        secrets,
        baseUrl: 'https://ksp.bj/recouvrement',
        closedAccessDays: 30,
      },
    });
    for (const [id, stored] of caseWorld().deps.rules.rules) deps.rules.rules.set(id, stored);
    return { deps, useCases: createUseCases(deps), notifier, secrets };
  }
  type World = ReturnType<typeof world>;

  /** Dossier actif de 750 000 FCFA, accepté sur la base. */
  async function activeCase(w: World, key: string) {
    w.deps.clock.current = NOW;
    // Une pièce propre à chaque dossier : file refuse une pièce déjà rattachée à un autre objet.
    const created = await asCreditor(() =>
      w.useCases.createCase.execute({
        idempotencyKey: key,
        input: caseInput({ evidenceFileIds: [ids.next()] }),
      }),
    );
    const caseId = created.view.record.id;
    const prepared = await asCreditor(() =>
      w.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: true }),
    );
    await w.useCases.recordMandateSignature.execute({
      eventId: ids.next(),
      documentId: prepared.documentId,
      template: 'recovery_mandate',
      producerService: 'recovery',
      subjectType: 'recovery_case',
      subjectId: caseId,
      signerUserId: CREDITOR_ID,
      signedAt: NOW.toISOString(),
    });
    prepaid.balances.set(CREDITOR_ID, 100_000);
    await asCreditor(() => w.useCases.payCaseFee.execute({ caseId, idempotencyKey: `pay-${key}` }));
    const accepted = await asStaff(SUPERVISOR_ID, ['recovery_supervisor'], () =>
      w.useCases.assessCase.execute({
        caseId,
        idempotencyKey: `assess-${key}`,
        decision: 'accept',
        note: '',
        agentUserId: '',
        rejectionReason: '',
      }),
    );
    return accepted.record;
  }

  /** Paiement par lien du débiteur à l'heure du monde (événement `payment.link.paid`). */
  async function pay(w: World, caseId: string, debtorId: string, amount: number) {
    await w.useCases.createDebtorPayment.execute({
      caseId,
      debtorId,
      idempotencyKey: `pay-${ids.next()}`,
      amount,
      settlementId: '',
    });
    const [request] = await w.deps.money.activePaymentRequests(caseId);
    expect(
      await w.useCases.recordLinkPayment.execute({
        eventId: ids.next(),
        paymentId: ids.next(),
        subjectType: 'recovery_payment_request',
        subjectId: request!.id,
        amount,
        providerReference: 'FEDA-1',
        paidAt: w.deps.clock.current.toISOString(),
      }),
    ).toBe('recorded');
  }

  const invoiceEvent = (period: string) => ({
    eventId: ids.next(),
    invoiceId: ids.next(),
    invoiceNumber: `FCR-2026-${period.slice(5)}0001`,
    creditor: { type: 'user', id: CREDITOR_ID },
    period,
    issuedAt: '2026-12-01T00:00:00.000Z',
  });

  it('relevés : un par dossier et par mois, facture rattachée avant ou après, liste paginée', async () => {
    const w = world();
    const first = await activeCase(w, 'case-key-statement-1');
    const second = await activeCase(w, 'case-key-statement-2');
    await pay(w, first.id, first.debtors[0]!.id, 100_000);
    await pay(w, second.id, second.debtors[0]!.id, 50_000);

    // Facture de novembre reçue avant les relevés : rattachée à leur enregistrement.
    const november = invoiceEvent('2026-11');
    expect(await w.useCases.recordCommissionInvoice.execute(november)).toEqual({
      outcome: 'recorded',
      statements: 0,
    });
    expect(await w.useCases.recordCommissionInvoice.execute(november)).toEqual({
      outcome: 'duplicate',
      statements: 0,
    });

    w.deps.clock.current = new Date('2026-11-30T23:30:00.000Z');
    expect(await w.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 2, failed: 0 });
    expect(await w.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 0, failed: 0 });
    const rows = await prisma.statement.findMany({
      where: { period: '2026-11' },
      orderBy: { collected: 'desc' },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        caseId: first.id,
        creditorType: 'user',
        creditorId: CREDITOR_ID,
        collected: 100_000,
        commission: 10_000,
        costs: 0,
        remitted: 90_000,
        invoiceId: november.invoiceId,
      }),
      expect.objectContaining({ caseId: second.id, collected: 50_000, remitted: 45_000 }),
    ]);
    // Un seul relevé par dossier et par mois, même écrit deux fois.
    expect(
      await w.deps.statements.insert({
        id: ids.next(),
        caseId: first.id,
        caseNumber: first.number,
        creditor: first.creditor,
        period: '2026-11',
        collected: 1,
        commission: 0,
        costs: 0,
        remitted: 1,
        documentId: ids.next(),
        documentNumber: 'REL-2026-999999',
        invoiceId: null,
        issuedAt: w.deps.clock.current,
      }),
    ).toBe(false);

    // Décembre : nouveau paiement, relevé le 1er janvier, facture reçue ensuite.
    w.deps.clock.current = new Date('2026-12-10T10:00:00.000Z');
    await pay(w, first.id, first.debtors[0]!.id, 20_000);
    w.deps.clock.current = new Date('2026-12-31T23:30:00.000Z');
    expect(await w.useCases.issueMonthlyStatements.execute()).toEqual({ issued: 1, failed: 0 });
    const december = invoiceEvent('2026-12');
    expect(await w.useCases.recordCommissionInvoice.execute(december)).toEqual({
      outcome: 'recorded',
      statements: 1,
    });

    const all = await asCreditor(() =>
      w.useCases.listMyStatements.execute({ period: '', caseId: first.id, page: { limit: 1 } }),
    );
    expect(all.items.map((item) => [item.period, item.collected, item.invoiceId])).toEqual([
      ['2026-12', 20_000, december.invoiceId],
    ]);
    const next = await asCreditor(() =>
      w.useCases.listMyStatements.execute({
        period: '',
        caseId: first.id,
        page: { limit: 1, cursor: all.nextCursor! },
      }),
    );
    expect(next.items.map((item) => [item.period, item.caseNumber])).toEqual([['2026-11', first.number]]);
    expect(next.nextCursor).toBeNull();
    const november2 = await asCreditor(() =>
      w.useCases.listMyStatements.execute({ period: '2026-11', caseId: '' }),
    );
    expect(november2.items).toHaveLength(2);
  });

  it('contestation : réponse demandée au créancier, close à la résolution, une seule ouverte', async () => {
    const w = world();
    const record = await activeCase(w, 'case-key-dispute-1');
    const debtorId = record.debtors[0]!.id;
    // Demande restée ouverte (clôture manquée) : close par la nouvelle, dans la même transaction.
    const leftover = ids.next();
    await prisma.decision.create({
      data: {
        id: leftover,
        caseId: record.id,
        type: 'dispute_response',
        status: 'pending',
        payload: { disputeId: ids.next() },
        requestedAt: NOW,
        expiresAt: new Date(NOW.getTime() + DAY_MS),
      },
    });
    const dispute = await w.useCases.disputeDebtorCase.execute({
      caseId: record.id,
      debtorId,
      idempotencyKey: 'dispute-key-int-1',
      reason: 'wrong_amount',
      text: 'Montant faux',
      fileIds: [],
    });
    expect(await prisma.decision.findUnique({ where: { id: leftover } })).toMatchObject({
      status: 'expired',
    });
    expect(await prisma.decision.findUnique({ where: { id: disputeResponseId(dispute.id) } })).toMatchObject({
      type: 'dispute_response',
      status: 'pending',
      payload: { disputeId: dispute.id },
      expiresAt: dispute.creditorAnswerDueAt,
    });
    const listed = await asCreditor(() =>
      w.useCases.listMyDecisions.execute({ statuses: [], caseId: record.id }),
    );
    expect(listed.items.map((item) => [item.decision.kind, item.dispute?.dispute.id])).toEqual([
      ['dispute_response', dispute.id],
    ]);

    await asStaff('0192f1c4-0000-7000-8000-000000001e9a', ['legal_officer'], () =>
      w.useCases.resolveDispute.execute({
        caseId: record.id,
        disputeId: dispute.id,
        resolution: 'resume',
        correctedDue: null,
        note: 'Montant vérifié',
      }),
    );
    expect(await prisma.decision.findUnique({ where: { id: disputeResponseId(dispute.id) } })).toMatchObject({
      status: 'expired',
    });
    expect((await w.deps.cases.find(record.id))!.status).toBe('active');
  });

  it('clôture : liens bornés à la clôture + 30 jours, session en lecture seule', async () => {
    const w = world();
    const record = await activeCase(w, 'case-key-closed-1');
    const debtorId = record.debtors[0]!.id;
    await pay(w, record.id, debtorId, 750_000);
    const closed = await prisma.recoveryCase.findUniqueOrThrow({ where: { id: record.id } });
    expect(closed).toMatchObject({ status: 'closed', closureReason: 'paid' });
    expect(closed.closureCompletedAt).not.toBeNull();
    const links = await prisma.debtorAccess.findMany({ where: { caseId: record.id, revokedAt: null } });
    expect(links.map((link) => link.expiresAt)).toEqual([new Date(closed.closedAt!.getTime() + 30 * DAY_MS)]);
    expect(await w.deps.debtorAccess.reader.caseDebtor(record.id, debtorId)).toMatchObject({
      caseStatus: 'closed',
      closedAt: closed.closedAt,
    });

    const link = w.notifier.sent.find((message) => message.message === 'settlement_certificate')!;
    const token = link.variables['link']!.split('/').pop()!;
    w.secrets.nextCodes.push('135790');
    const sessionToken = await asService('gateway', async () => {
      await w.useCases.sendDebtorAccessCode.execute({ token });
      return (await w.useCases.verifyDebtorAccessCode.execute({ token, code: '135790' })).sessionToken;
    });
    await expect(
      asService('gateway', () => w.useCases.resolveDebtorSession.execute({ sessionToken, use: 'read' })),
    ).resolves.toMatchObject({ caseId: record.id, readOnly: true });
    await expect(
      asService('gateway', () => w.useCases.resolveDebtorSession.execute({ sessionToken, use: 'write' })),
    ).rejects.toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
  });
});
