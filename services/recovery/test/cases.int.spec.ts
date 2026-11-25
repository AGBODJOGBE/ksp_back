import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlindIndex, FieldCipher, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { emptyCase, nameTokens } from '../src/application/cases/case-rules';
import { withContent } from '../src/application/cases/case-input';
import { noChanges, type RecoveryCaseRecord } from '../src/application/cases/ports';
import {
  MemoryCreditorProfiles,
  MemoryDirectory,
  MemoryDocuments,
  MemoryFiles,
  MemorySpreadsheets,
  MemoryWallet,
} from '../src/application/testing/case-fakes';
import {
  caseInput,
  caseWorld,
  FEE_RULE_ID,
  FILE_1,
  FILE_2,
  SUPERVISOR_ID,
} from '../src/application/testing/case-scenarios';
import {
  asCreditor,
  asStaff,
  CREDITOR_ID,
  makeDeps,
  NOW,
  SequentialIds,
} from '../src/application/testing/fakes';
import { createUseCases } from '../src/application/use-cases';
import { PrismaCaseImportRepository } from '../src/infrastructure/persistence/prisma-case-imports.repository';
import { PrismaCaseQueries } from '../src/infrastructure/persistence/prisma-case-queries';
import { PrismaCaseRepository } from '../src/infrastructure/persistence/prisma-cases.repository';
import { PrismaCreditorPreferencesStore } from '../src/infrastructure/persistence/prisma-creditor-preferences.store';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { KitPersonalData } from '../src/infrastructure/security/kit-personal-data';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Dépôts des dossiers contre un vrai PostgreSQL (lot R2) : agrégat chiffré et relu, numéro RC tiré de
 * la séquence, verrou optimiste, journal de preuve, outbox et audit dans la transaction de l'état,
 * inbox, recherche par empreinte (téléphone, mots du nom), suppression d'un brouillon (journal
 * compris), imports, préférences, et un parcours complet des cas d'usage sur ces dépôts. Schéma
 * jetable ; ignoré sans TEST_DATABASE_URL.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const OTHER_CREDITOR = '0192f1c4-0000-7000-8000-00000000c009';

describeWithDatabase('dossiers du recouvrement (PostgreSQL)', () => {
  const schema = `recovery_cases_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let personal: KitPersonalData;
  let cases: PrismaCaseRepository;
  let queries: PrismaCaseQueries;
  let imports: PrismaCaseImportRepository;
  const ids = new SequentialIds();

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
    cases = new PrismaCaseRepository(prisma, personal);
    queries = new PrismaCaseQueries(prisma, personal);
    imports = new PrismaCaseImportRepository(prisma, personal);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  /** Brouillon du formulaire, rempli comme le fait CreateCase. */
  function draft(id: string, key: string | null, creditorId = CREDITOR_ID): RecoveryCaseRecord {
    const base = emptyCase({
      id,
      creditor: { type: 'user', id: creditorId },
      createdBy: creditorId,
      source: 'form',
      importId: null,
      idempotencyKey: key,
      planScale: null,
      now: NOW,
    });
    const input = caseInput();
    const content = {
      kind: 'b2b' as const,
      nature: 'unpaid_invoice' as const,
      debtors: [
        {
          kind: 'company' as const,
          role: 'main' as const,
          firstNames: null,
          lastName: null,
          legalName: 'SARL Bénin Négoce',
          ifu: '3201900000001',
          rccm: null,
          representativeName: null,
          address: 'Akpakpa, Cotonou',
          communeKey: 'cotonou',
          phones: ['+2290197000101'],
          emails: ['compta@negoce.bj'],
        },
      ],
      claims: input.claims.map((claim) => ({
        reference: claim.reference,
        nature: 'unpaid_invoice' as const,
        principal: claim.amount!,
        dueDate: claim.dueDate,
        description: claim.description || null,
      })),
      interests: 0,
      alreadyPaid: 100_000,
      priorEffort: {
        remindersCount: 2,
        lastReminderDate: '2026-11-01',
        channels: ['phone'],
        acknowledged: false,
        acknowledgmentFileId: null,
        promises: null,
      },
      preserveRelationship: true,
      planScale: null,
    };
    return {
      ...withContent(base, content, () => ids.next()),
      documents: [
        {
          id: ids.next(),
          kind: 'evidence',
          label: 'Justificatif 1',
          fileId: FILE_1,
          documentId: null,
          visibleToPartner: false,
          visibleToDebtor: false,
          addedBy: { type: 'creditor', id: creditorId },
          addedAt: NOW,
        },
      ],
    };
  }

  const CASE_A = '0192f1c4-0000-7000-8000-00000000ca5a';
  const CASE_B = '0192f1c4-0000-7000-8000-00000000ca5b';

  it('enregistre un dossier chiffré, numéroté par la séquence, et le relit à l’identique', async () => {
    const record = draft(CASE_A, 'case-key-int-1');
    const changes = noChanges();
    changes.evidence.push({
      id: ids.next(),
      caseId: CASE_A,
      occurredAt: NOW,
      actor: { type: 'creditor', id: CREDITOR_ID },
      action: 'case.created',
      kind: 'status_changed',
      summary: 'Dossier créé (brouillon)',
      channel: null,
      direction: null,
      outcome: null,
      deliveryStatus: null,
      amount: null,
      internal: false,
      ref: null,
    });
    const created = await cases.create(record, changes);
    expect(created).toMatchObject({ number: 'RC-000001', version: 0 });
    expect(await cases.create(record, noChanges())).toBe('duplicate');

    const raw = await pool.query(
      `SELECT d.identity_enc, d.addresses_enc, d.name_tokens, c.value_enc FROM debtors d
       JOIN debtor_contacts c ON c.debtor_id = d.id`,
    );
    expect(JSON.stringify(raw.rows)).not.toMatch(/Négoce|97000101|negoce\.bj|Akpakpa/);
    expect(raw.rows[0].name_tokens).toEqual(
      nameTokens('SARL Bénin Négoce').map((t) => personal.nameIndex(t)),
    );

    const found = await cases.find(CASE_A);
    expect(found).toMatchObject({
      number: 'RC-000001',
      status: 'draft',
      principal: 750_000,
      paid: 100_000,
      earliestDueDate: '2026-09-30',
      communeKey: 'cotonou',
      preserveRelationship: true,
      priorEffort: { remindersCount: 2, lastReminderDate: '2026-11-01', channels: ['phone'] },
    });
    expect(found!.debtors).toEqual(record.debtors);
    expect(found!.claims).toEqual(record.claims);
    expect(found!.documents).toEqual(record.documents);
    expect((await cases.findByIdempotencyKey({ type: 'user', id: CREDITOR_ID }, 'case-key-int-1'))!.id).toBe(
      CASE_A,
    );
    expect(found!.lastActionAt).toEqual(NOW);
  });

  it('verrou optimiste ; journal, passages d’étape, audit et outbox écrits avec l’état ; inbox', async () => {
    const current = (await cases.find(CASE_A))!;
    const changes = noChanges();
    changes.events.push({
      type: 'recovery.case.submitted',
      payload: {
        caseId: CASE_A,
        caseNumber: current.number,
        creditor: current.creditor,
        kind: 'b2b',
        amountDue: { amount: 650_000, currency: 'XOF' },
        source: 'form',
        submittedAt: NOW.toISOString(),
      },
    });
    changes.audit.push({
      actorId: SUPERVISOR_ID,
      action: 'case.assigned',
      entityType: 'recovery_case',
      entityId: CASE_A,
      at: NOW,
      details: { to: SUPERVISOR_ID },
    });
    changes.stageTransitions.push({
      id: ids.next(),
      from: null,
      to: 'notice',
      at: NOW,
      by: { type: 'agent', id: SUPERVISOR_ID },
      reason: 'Dossier recevable',
      skipReason: null,
    });
    const next = {
      ...current,
      status: 'under_review' as const,
      submittedAt: NOW,
      fee: { ...current.fee, amount: 25_000 },
    };
    expect(await cases.save({ ...next, version: 5 }, changes)).toBe('stale');
    expect(await pool.query('SELECT 1 FROM outbox')).toMatchObject({ rowCount: 0 });
    expect(await cases.save(next, changes)).toBe('saved');
    const reread = (await cases.find(CASE_A))!;
    expect(reread).toMatchObject({ status: 'under_review', version: 1, fee: { amount: 25_000 } });
    const outbox = await pool.query('SELECT event_type, payload FROM outbox');
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['recovery.case.submitted']);
    expect(outbox.rows[0].payload).toMatchObject({ producer: 'recovery', payload: { caseId: CASE_A } });
    expect((await queries.stageHistory(CASE_A)).map((t) => [t.from, t.to])).toEqual([[null, 'notice']]);
    expect((await pool.query(`SELECT action FROM audit_log WHERE entity_id = $1`, [CASE_A])).rows).toEqual([
      { action: 'case.assigned' },
    ]);
    const inbox = { eventId: '0192f1c4-0000-7000-8000-0000000e0042', consumer: 'recovery.test' };
    expect(await cases.save(reread, noChanges(), { inbox })).toBe('saved');
    expect(await cases.save({ ...reread, version: 2 }, noChanges(), { inbox })).toBe('duplicate');
  });

  it('retrouve un dossier ouvert semblable par l’empreinte du téléphone (ancienne forme comprise)', async () => {
    const similar = await cases.findSimilarOpen(
      { type: 'user', id: CREDITOR_ID },
      { phones: ['+22997000101'], emails: [], references: ['F-2026-002'] },
      null,
    );
    expect(similar.map((item) => [item.number, item.debtorName])).toEqual([
      ['RC-000001', 'SARL Bénin Négoce'],
    ]);
    expect(
      await cases.findSimilarOpen(
        { type: 'user', id: CREDITOR_ID },
        { phones: ['+22997000101'], emails: [], references: ['AUTRE'] },
        null,
      ),
    ).toEqual([]);
  });

  it('listes, recherche par numéro ou nom, journal paginé, tableaux de bord', async () => {
    await cases.create(draft(CASE_B, 'case-key-int-2', OTHER_CREDITOR), noChanges());
    await pool.query(
      `INSERT INTO collections (id, case_id, source, reference, gross, allocated_costs, allocated_interests,
         allocated_principal, overpaid, commission_base, commission, net, stage_group, collected_at)
       VALUES ('0192f1c4-0000-7000-8000-0000000c0111', $1, 'payment_link', 'payment:1', 60000, 0, 0, 60000, 0,
         60000, 6000, 54000, 'amicable', now())`,
      [CASE_A],
    );
    const page = { limit: 1, cursor: null };
    const all = await queries.list({}, page);
    expect(all).toMatchObject({ total: 2, items: [{ number: 'RC-000002' }] });
    const second = await queries.list({}, { limit: 1, cursor: all.nextCursor });
    expect(second.items.map((item) => item.number)).toEqual(['RC-000001']);
    const mine = await queries.list(
      { creditor: { type: 'user', id: CREDITOR_ID } },
      { limit: 20, cursor: null },
    );
    expect(mine.total).toBe(1);
    expect((await queries.list({ number: '000002' }, { limit: 20, cursor: null })).items[0]!.id).toBe(CASE_B);
    expect((await queries.list({ debtorNameTokens: ['negoce'] }, { limit: 20, cursor: null })).total).toBe(2);
    expect((await queries.list({ debtorNameTokens: ['nego'] }, { limit: 20, cursor: null })).total).toBe(0);
    expect((await queries.list({ statuses: ['under_review'] }, { limit: 20, cursor: null })).total).toBe(1);

    const journal = await queries.journal(CASE_A, { includeInternal: false }, { limit: 20, cursor: null });
    expect(journal.items.map((entry) => [entry.action, entry.kind])).toEqual([
      ['case.created', 'status_changed'],
    ]);

    const dashboard = await queries.creditorDashboard({ type: 'user', id: CREDITOR_ID }, '2026-11-20');
    expect(dashboard).toMatchObject({
      entrusted: 650_000,
      recovered: 60_000,
      outstanding: 650_000,
      pendingDecisions: 0,
    });
    const overview = await queries.overview({ agentId: null, communeKey: null }, '2026-11-20', {
      idleSince: new Date(NOW.getTime() - 7 * 86_400_000),
      prescriptionBefore: '2027-02-18',
    });
    expect(overview).toMatchObject({
      reviewQueue: 1,
      entrusted: 650_000,
      recovered: 60_000,
      recoveredByStageGroup: [{ stage: 'amicable', amount: 60_000 }],
      casesByKind: [{ stage: 'b2b', count: 1 }],
    });
  });

  it('supprime un brouillon non payé, journal compris (purge déclarée), trace d’audit gardée', async () => {
    const record = (await cases.find(CASE_B))!;
    await pool.query(
      `INSERT INTO evidence_entries (id, case_id, occurred_at, actor_type, action, summary)
       VALUES ('0192f1c4-0000-7000-8000-0000000e0b01', $1, now(), 'creditor', 'case.created', 'Dossier créé')`,
      [CASE_B],
    );
    expect(await cases.listUnpaidCreatedBefore(NOW, 10)).toEqual([expect.objectContaining({ id: CASE_B })]);
    const audit = {
      actorId: 'system',
      action: 'case.unpaid_deleted',
      entityType: 'recovery_case' as const,
      entityId: CASE_B,
      at: NOW,
    };
    expect(await cases.deleteUnpaid({ ...record, version: 9 }, audit)).toBe(false);
    expect(await cases.deleteUnpaid(record, audit)).toBe(true);
    expect(await cases.find(CASE_B)).toBeNull();
    expect((await pool.query('SELECT 1 FROM evidence_entries WHERE case_id = $1', [CASE_B])).rowCount).toBe(
      0,
    );
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE entity_id = $1`, [CASE_B])).rowCount).toBe(1);
    // Le journal reste en ajout seul hors de cette suppression.
    await expect(pool.query(`DELETE FROM evidence_entries`)).rejects.toThrow(/ajout seul/);
  });

  it('imports : lignes chiffrées, verrou, confirmation en une transaction ; préférences', async () => {
    const record = {
      id: '0192f1c4-0000-7000-8000-0000001a9001',
      creditor: { type: 'user' as const, id: CREDITOR_ID },
      createdBy: CREDITOR_ID,
      kind: 'b2c' as const,
      fileId: FILE_2,
      evidenceArchiveFileId: null,
      status: 'checked' as const,
      idempotencyKey: 'import-key-int-1',
      createdAt: NOW,
      updatedAt: NOW,
      version: 0,
      lines: [
        {
          row: 1,
          values: {
            debtorKind: 'person',
            debtorName: 'Dossou',
            debtorFirstNames: 'Koffi',
            debtorIfu: '',
            debtorPhone: '96000301',
            debtorEmail: '',
            debtorAddress: '',
            invoiceReference: 'B-1',
            amount: '80000',
            dueDate: '2026-10-01',
            description: '',
            nature: '',
          },
          status: 'valid' as const,
          errors: [],
          caseId: null,
        },
      ],
    };
    expect(await imports.create(record)).toBe('created');
    expect(await imports.create(record)).toBe('duplicate');
    const raw = await pool.query('SELECT values_enc FROM case_import_lines');
    expect(JSON.stringify(raw.rows)).not.toContain('Dossou');
    expect((await imports.find(record.id))!.lines[0]!.values.debtorName).toBe('Dossou');
    expect(await imports.saveLines({ ...record, version: 3 })).toBe(false);
    expect(await imports.saveLines(record)).toBe(true);

    const imported = withContent(
      emptyCase({
        id: '0192f1c4-0000-7000-8000-0000001a9c01',
        creditor: record.creditor,
        createdBy: CREDITOR_ID,
        source: 'import',
        importId: record.id,
        idempotencyKey: null,
        planScale: null,
        now: NOW,
      }),
      {
        kind: 'b2c',
        nature: 'unpaid_invoice',
        debtors: [
          {
            kind: 'person',
            role: 'main',
            firstNames: 'Koffi',
            lastName: 'Dossou',
            legalName: null,
            ifu: null,
            rccm: null,
            representativeName: null,
            address: null,
            communeKey: null,
            phones: ['+2290196000301'],
            emails: [],
          },
        ],
        claims: [
          {
            reference: 'B-1',
            nature: 'unpaid_invoice',
            principal: 80_000,
            dueDate: '2026-10-01',
            description: null,
          },
        ],
        interests: 0,
        alreadyPaid: 0,
        priorEffort: {
          remindersCount: 0,
          lastReminderDate: null,
          channels: [],
          acknowledged: false,
          acknowledgmentFileId: null,
          promises: null,
        },
        preserveRelationship: false,
        planScale: null,
      },
      () => ids.next(),
    );
    const confirmed = {
      ...record,
      version: 1,
      status: 'confirmed' as const,
      lines: [{ ...record.lines[0]!, caseId: imported.id }],
    };
    const created = await imports.confirm(confirmed, [{ record: imported, changes: noChanges() }]);
    expect(created).toEqual([expect.objectContaining({ id: imported.id, number: 'RC-000003' })]);
    expect(await imports.confirm(confirmed, [])).toBe('stale');
    expect((await imports.find(record.id))!).toMatchObject({
      status: 'confirmed',
      lines: [{ caseId: imported.id }],
    });

    const preferences = new PrismaCreditorPreferencesStore(prisma);
    expect(await preferences.get({ type: 'user', id: CREDITOR_ID })).toBeNull();
    const scale = {
      acceptsPaymentPlan: true,
      maxDurationMonths: 4,
      minFirstPaymentBps: 1_000,
      firstPaymentWithinDays: 15,
      minInstallment: 10_000,
      maxDiscountBps: 0,
    };
    await preferences.save(
      { type: 'user', id: CREDITOR_ID },
      { b2bScale: scale, b2cScale: scale, notifyUserIds: [CREDITOR_ID] },
      CREDITOR_ID,
      NOW,
    );
    expect(await preferences.get({ type: 'user', id: CREDITOR_ID })).toMatchObject({
      b2bScale: scale,
      notifyUserIds: [CREDITOR_ID],
      updatedBy: CREDITOR_ID,
    });
  });

  it('parcours complet sur la base : brouillon, mandat signé, frais payés, dossier recevable', async () => {
    const wallet = new MemoryWallet();
    const deps = makeDeps({
      cases,
      caseQueries: queries,
      imports,
      preferences: new PrismaCreditorPreferencesStore(prisma),
      wallet,
      documents: new MemoryDocuments(),
      files: new MemoryFiles(),
      directory: new MemoryDirectory(),
      creditorProfiles: new MemoryCreditorProfiles(),
      spreadsheets: new MemorySpreadsheets(),
      ids: new UuidV7Generator(),
    });
    for (const [id, stored] of caseWorld().deps.rules.rules) deps.rules.rules.set(id, stored);
    expect(deps.rules.rules.has(FEE_RULE_ID)).toBe(true);
    const useCases = createUseCases(deps);

    const created = await asCreditor(() =>
      useCases.createCase.execute({
        idempotencyKey: 'case-key-int-9',
        input: caseInput({
          claims: [{ reference: 'Z-1', amount: 300_000, dueDate: '2026-10-01', description: '' }],
          evidenceFileIds: ['0192f1c4-0000-7000-8000-0000000f0909'],
        }),
      }),
    );
    const caseId = created.view.record.id;
    expect(created.view.record.number).toBe('RC-000004');
    const prepared = await asCreditor(() =>
      useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: true }),
    );
    expect(
      await useCases.recordMandateSignature.execute({
        eventId: '0192f1c4-0000-7000-8000-0000000e0909',
        documentId: prepared.documentId,
        template: 'recovery_mandate',
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: caseId,
        signerUserId: CREDITOR_ID,
        signedAt: NOW.toISOString(),
      }),
    ).toBe('recorded');
    wallet.balances.set(CREDITOR_ID, 50_000);
    const paid = await asCreditor(() =>
      useCases.payCaseFee.execute({ caseId, idempotencyKey: 'pay-key-int-9' }),
    );
    expect(paid.record).toMatchObject({ status: 'under_review', fee: { amount: 10_000, paidAt: NOW } });
    const accepted = await asStaff(SUPERVISOR_ID, ['recovery_supervisor'], () =>
      useCases.assessCase.execute({
        caseId,
        idempotencyKey: 'assess-key-int-9',
        decision: 'accept',
        note: '',
        agentUserId: '',
        rejectionReason: '',
      }),
    );
    expect(accepted.record).toMatchObject({ status: 'active', stage: 'notice' });
    expect(accepted.stageHistory).toHaveLength(1);
    const journal = await asCreditor(() => useCases.listMyCaseJournal.execute({ caseId }));
    expect(journal.entries.map((item) => item.entry.action)).toEqual([
      'case.accepted',
      'case.submitted',
      'fee.paid',
      'mandate.signed',
      'mandate.prepared',
      'case.created',
    ]);
    const events = await pool.query(
      `SELECT event_type FROM outbox WHERE payload->'payload'->>'caseId' = $1 ORDER BY created_at, id`,
      [caseId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'recovery.case.submitted',
      'recovery.case.accepted',
      'recovery.case.stage_changed',
    ]);
  });
});
