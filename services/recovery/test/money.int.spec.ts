import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlindIndex, FieldCipher, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import {
  MemoryCreditorProfiles,
  MemoryDirectory,
  MemoryDocuments,
  MemoryFiles,
  MemorySpreadsheets,
  MemoryWallet,
} from '../src/application/testing/case-fakes';
import { caseInput, caseWorld, SUPERVISOR_ID } from '../src/application/testing/case-scenarios';
import { asCreditor, asStaff, CREDITOR_ID, makeDeps, NOW } from '../src/application/testing/fakes';
import {
  MemoryDebtorUploads,
  MemoryDocumentUrls,
  MemoryNotifier,
  MemoryPaymentLinks,
  MoneyWallet,
} from '../src/application/testing/money-fakes';
import { asFinance, FINANCE_A, FINANCE_B } from '../src/application/testing/money-scenarios';
import { createUseCases } from '../src/application/use-cases';
import { PrismaCaseImportRepository } from '../src/infrastructure/persistence/prisma-case-imports.repository';
import { PrismaCaseQueries } from '../src/infrastructure/persistence/prisma-case-queries';
import { PrismaCaseRepository } from '../src/infrastructure/persistence/prisma-cases.repository';
import { PrismaCreditorPreferencesStore } from '../src/infrastructure/persistence/prisma-creditor-preferences.store';
import { PrismaMoneyStore } from '../src/infrastructure/persistence/prisma-money.store';
import { PrismaAuditLog } from '../src/infrastructure/persistence/prisma-settings.stores';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { KitPersonalData } from '../src/infrastructure/security/kit-personal-data';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Argent et espace du débiteur contre un vrai PostgreSQL (lot R3) : lien payé (inbox, encaissement
 * unique par référence), crédit et reçu, validation à deux d'un paiement hors ligne, paiement direct,
 * contestation et rappel chiffrés, clôture « payé » et ses effets, trop-perçu remboursé, listes
 * paginées. Schéma jetable ; ignoré sans TEST_DATABASE_URL.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

describeWithDatabase('argent du recouvrement (PostgreSQL)', () => {
  const schema = `recovery_money_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let personal: KitPersonalData;
  // Un seul portefeuille prépayé : ses débits restent uniques en base d'un test à l'autre.
  const prepaid = new MemoryWallet();
  const paymentLinks = new MemoryPaymentLinks();

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
    const wallet = new MoneyWallet(prepaid);
    const directory = new MemoryDirectory();
    directory.users.set(CREDITOR_ID, 'Awa Créancière');
    const money = new PrismaMoneyStore(prisma, personal);
    const deps = makeDeps({
      cases: new PrismaCaseRepository(prisma, personal),
      caseQueries: new PrismaCaseQueries(prisma, personal),
      imports: new PrismaCaseImportRepository(prisma, personal),
      preferences: new PrismaCreditorPreferencesStore(prisma),
      audit: new PrismaAuditLog(prisma),
      wallet,
      documents: new MemoryDocuments(),
      files: new MemoryFiles(),
      directory,
      creditorProfiles: new MemoryCreditorProfiles(),
      spreadsheets: new MemorySpreadsheets(),
      paymentLinks,
      notifier: new MemoryNotifier(),
      money,
      debtorUploads: new MemoryDebtorUploads(),
      documentUrls: new MemoryDocumentUrls(),
      ids: new UuidV7Generator(),
    });
    for (const [id, stored] of caseWorld().deps.rules.rules) deps.rules.rules.set(id, stored);
    return { deps, useCases: createUseCases(deps), prepaid, wallet, paymentLinks, money };
  }

  /** Dossier actif de 750 000 FCFA (deux factures), accepté sur la base. */
  async function activeCase(w: ReturnType<typeof world>, key: string) {
    const created = await asCreditor(() =>
      w.useCases.createCase.execute({ idempotencyKey: key, input: caseInput() }),
    );
    const caseId = created.view.record.id;
    const prepared = await asCreditor(() =>
      w.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: true }),
    );
    await w.useCases.recordMandateSignature.execute({
      eventId: new UuidV7Generator().next(),
      documentId: prepared.documentId,
      template: 'recovery_mandate',
      producerService: 'recovery',
      subjectType: 'recovery_case',
      subjectId: caseId,
      signerUserId: CREDITOR_ID,
      signedAt: NOW.toISOString(),
    });
    w.prepaid.balances.set(CREDITOR_ID, 100_000);
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

  const outbox = async (caseId: string) =>
    (
      await pool.query(
        `SELECT event_type FROM outbox WHERE payload->'payload'->>'caseId' = $1 ORDER BY created_at, id`,
        [caseId],
      )
    ).rows.map((row) => row.event_type as string);

  it('lien payé une seule fois, hors ligne validé à deux, paiement direct, clôture « payé »', async () => {
    const w = world();
    const record = await activeCase(w, 'case-key-money-1');
    const scope = { caseId: record.id, debtorId: record.debtors[0]!.id };

    // Lien de 100 000 FCFA payé : l'événement rejoué n'a qu'un effet (inbox, référence unique).
    const link = await w.useCases.createDebtorPayment.execute({
      ...scope,
      idempotencyKey: 'pay-link-key-1',
      amount: 100_000,
      settlementId: '',
    });
    expect(
      (
        await w.useCases.createDebtorPayment.execute({
          ...scope,
          idempotencyKey: 'pay-link-key-1',
          amount: 100_000,
          settlementId: '',
        })
      ).url,
    ).toBe(link.url);
    const [request] = await w.money.activePaymentRequests(record.id);
    const event = {
      eventId: '0192f1c4-0000-7000-8e00-000000000101',
      paymentId: '0192f1c4-0000-7000-8f00-000000000101',
      subjectType: 'recovery_payment_request',
      subjectId: request!.id,
      amount: 100_000,
      providerReference: 'FEDA-101',
      paidAt: '2026-11-20T10:00:00.000Z',
    };
    expect(await w.useCases.recordLinkPayment.execute(event)).toBe('recorded');
    expect(await w.useCases.recordLinkPayment.execute(event)).toBe('duplicate');
    const [linkCollection] = await w.money.collections(record.id);
    expect(linkCollection).toMatchObject({
      gross: 100_000,
      commission: 10_000,
      net: 90_000,
      dueBefore: 750_000,
    });
    expect(linkCollection!.creditedAt).not.toBeNull();
    expect(linkCollection!.receiptDocumentId).not.toBeNull();
    expect(await w.money.paymentRequest(request!.id)).toMatchObject({ status: 'paid' });

    // Hors ligne : saisi par A, validé par B.
    const offline = await asFinance(FINANCE_A, () =>
      w.useCases.recordOfflinePayment.execute({
        caseId: record.id,
        idempotencyKey: 'offline-key-int-1',
        source: 'transfer',
        amount: 150_000,
        receivedOn: '2026-11-19',
        reference: 'VIR-2026-77',
        proofFileId: '',
      }),
    );
    const listed = await asFinance(FINANCE_B, () =>
      w.useCases.listOfflinePayments.execute({
        statuses: ['pending_approval'],
        caseId: record.id,
        page: { limit: 1 },
      }),
    );
    expect(listed.items.map((item) => item.payment.id)).toEqual([offline.payment.id]);
    const approved = await asFinance(FINANCE_B, () =>
      w.useCases.approveOfflinePayment.execute({ offlinePaymentId: offline.payment.id }),
    );
    expect(approved.collection).toMatchObject({ source: 'offline_transfer', gross: 150_000 });
    expect(await w.money.offlinePayment(offline.payment.id)).toMatchObject({
      status: 'approved',
      reviewedBy: FINANCE_B,
      collectionId: approved.collection.id,
    });

    // Paiement direct : facturé, non crédité.
    const direct = await asCreditor(() =>
      w.useCases.declareDirectPayment.execute({
        caseId: record.id,
        idempotencyKey: 'direct-key-int-1',
        amount: 100_000,
        receivedOn: '2026-11-18',
        note: '',
        proofFileId: '',
      }),
    );
    expect(direct.collection).toMatchObject({ settlement: 'invoiced', net: 0, creditedAt: null });

    // Le reste (400 000) par lien : dossier soldé, clos, effets terminés.
    await w.useCases.createDebtorPayment.execute({
      ...scope,
      idempotencyKey: 'pay-link-key-2',
      amount: 400_000,
      settlementId: '',
    });
    const [last] = await w.money.activePaymentRequests(record.id);
    await w.useCases.recordLinkPayment.execute({
      ...event,
      eventId: '0192f1c4-0000-7000-8e00-000000000102',
      paymentId: '0192f1c4-0000-7000-8f00-000000000102',
      subjectId: last!.id,
      amount: 400_000,
    });
    const closed = await w.deps.cases.find(record.id);
    expect(closed).toMatchObject({ status: 'closed', closureReason: 'paid', paid: 750_000 });
    const money = await w.money.money(record.id);
    expect(money.totals).toEqual({ base: 750_000, commission: 75_000 });
    expect(money.closure).toMatchObject({ closedBy: { type: 'system', id: null } });
    expect(money.closure!.completedAt).not.toBeNull();
    expect(money.closure!.certificateDocumentId).not.toBeNull();
    expect(closed!.documents.map((document) => document.kind)).toEqual(
      expect.arrayContaining(['receipt', 'settlement_certificate']),
    );
    expect(await w.money.pendingClosures(10)).toEqual([]);
    expect(await w.money.pendingSettlements(10)).toEqual([]);
    expect(await outbox(record.id)).toEqual([
      'recovery.case.submitted',
      'recovery.case.accepted',
      'recovery.case.stage_changed',
      'recovery.payment.collected',
      'recovery.remittance.paid',
      'recovery.payment.collected',
      'recovery.remittance.paid',
      'recovery.payment.collected',
      'recovery.payment.collected',
      'recovery.remittance.paid',
      'recovery.case.closed',
    ]);

    const remittances = await asCreditor(() =>
      w.useCases.listMyRemittances.execute({ caseId: '', from: '', to: '', page: { limit: 2 } }),
    );
    expect(remittances.items).toHaveLength(2);
    expect(remittances.nextCursor).not.toBeNull();
    const next = await asCreditor(() =>
      w.useCases.listMyRemittances.execute({
        caseId: '',
        from: '',
        to: '',
        page: { limit: 2, cursor: remittances.nextCursor! },
      }),
    );
    expect(next.items).toHaveLength(1);
  });

  it('contestation et rappel chiffrés, suite du juriste, trop-perçu remboursé', async () => {
    const w = world();
    const record = await activeCase(w, 'case-key-money-2');
    const scope = { caseId: record.id, debtorId: record.debtors[0]!.id };
    await w.useCases.requestDebtorCallback.execute({
      ...scope,
      preferredFrom: '2026-11-21T09:00:00.000Z',
      preferredTo: '2026-11-21T10:00:00.000Z',
      message: 'Appelez après 10 h',
    });
    const opened = await w.useCases.disputeDebtorCase.execute({
      ...scope,
      idempotencyKey: 'dispute-key-int-1',
      reason: 'wrong_amount',
      text: 'La seconde facture a été annulée.',
      fileIds: [],
    });
    const stored = await pool.query('SELECT text_enc FROM disputes WHERE id = $1', [opened.id]);
    expect(stored.rows[0].text_enc).not.toContain('annulée');
    const notes = await pool.query('SELECT note_enc FROM callback_requests WHERE case_id = $1', [record.id]);
    expect(notes.rows[0].note_enc).not.toContain('10 h');
    expect((await w.money.pendingCallbacks(record.id))[0]!.message).toBe('Appelez après 10 h');
    expect((await w.money.disputeByKey(record.id, 'dispute-key-int-1'))!.text).toBe(
      'La seconde facture a été annulée.',
    );

    const resolved = await asStaff('0192f1c4-0000-7000-8000-000000001e9a', ['legal_officer'], () =>
      w.useCases.resolveDispute.execute({
        caseId: record.id,
        disputeId: opened.id,
        resolution: 'correct_amount',
        correctedDue: 300_000,
        note: 'Facture F-2026-002 annulée',
      }),
    );
    expect(resolved.view.amounts.due).toBe(300_000);
    expect(resolved.disputes[0]).toMatchObject({
      status: 'amount_corrected',
      resolutionNote: 'Facture F-2026-002 annulée',
    });

    // Saisie de 300 000 en attente, puis 50 000 par lien : la validation laisse 50 000 de trop-perçu.
    const offline = await asFinance(FINANCE_A, () =>
      w.useCases.recordOfflinePayment.execute({
        caseId: record.id,
        idempotencyKey: 'offline-key-int-2',
        source: 'cash',
        amount: 300_000,
        receivedOn: '2026-11-20',
        reference: '',
        proofFileId: '',
      }),
    );
    await w.useCases.createDebtorPayment.execute({
      ...scope,
      idempotencyKey: 'pay-link-key-3',
      amount: 50_000,
      settlementId: '',
    });
    const [request] = await w.money.activePaymentRequests(record.id);
    await w.useCases.recordLinkPayment.execute({
      eventId: '0192f1c4-0000-7000-8e00-000000000201',
      paymentId: '0192f1c4-0000-7000-8f00-000000000201',
      subjectType: 'recovery_payment_request',
      subjectId: request!.id,
      amount: 50_000,
      providerReference: null,
      paidAt: '2026-11-20T10:00:00.000Z',
    });
    await asFinance(FINANCE_B, () =>
      w.useCases.approveOfflinePayment.execute({ offlinePaymentId: offline.payment.id }),
    );
    expect((await w.money.money(record.id)).overpaid).toBe(50_000);
    const refunded = await asFinance(FINANCE_A, () =>
      w.useCases.recordOverpaymentRefund.execute({
        caseId: record.id,
        idempotencyKey: 'refund-key-int-1',
        amount: 50_000,
        reference: 'MOMO-5544',
        note: 'Rendu au débiteur',
      }),
    );
    expect(refunded.view.amounts.overpaid).toBe(0);
    expect(await w.money.refundByKey(FINANCE_A, 'refund-key-int-1')).toMatchObject({ amount: 50_000 });
    const audit = await pool.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at, action`, [
      record.id,
    ]);
    expect(audit.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['dispute.resolved', 'offline_payment.approved', 'overpayment.refunded']),
    );
  });
});
