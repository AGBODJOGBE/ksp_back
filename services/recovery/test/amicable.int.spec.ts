import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlindIndex, FieldCipher, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { type AmicableStore, noAmicableChanges } from '../src/application/amicable/amicable.ports';
import { queuedMessage } from '../src/application/amicable/debtor-messages';
import { noChanges } from '../src/application/cases/ports';
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
import { AGENT_ID, asCreditor, asStaff, CREDITOR_ID, makeDeps, NOW } from '../src/application/testing/fakes';
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
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { KitPersonalData } from '../src/infrastructure/security/kit-personal-data';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Procédure amiable contre un vrai PostgreSQL (lot R4) : premier contact envoyé et tracé (file,
 * contact, journal, lien), échéancier hors barème validé puis accepté par le créancier, protocole
 * signé (inbox, étape, pièce, outbox), échéances déduites des encaissements (table du lot R3, lue
 * seulement), « Ma journée », verrous (version de l'échéancier, statut lu, index partiels), file des
 * messages réservée sans doublon. Schéma jetable ; ignoré sans TEST_DATABASE_URL.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');

describeWithDatabase('procédure amiable (PostgreSQL)', () => {
  const schema = `recovery_amicable_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  let amicable: AmicableStore;

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
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool?.end();
  });

  function world() {
    const personal = new KitPersonalData(
      FieldCipher.fromConfig(undefined, 'test', 'RECOVERY_PII_ENCRYPTION_KEYS'),
      BlindIndex.fromConfig(undefined, 'test', 'RECOVERY_BLIND_INDEX_KEYS'),
    );
    amicable = new PrismaAmicableStore(prisma, personal);
    const notifier = new CapturingNotifier();
    const wallet = new MemoryWallet();
    const directory = new MemoryDirectory();
    directory.users.set(CREDITOR_ID, 'Awa Dossou');
    const deps = makeDeps({
      personalData: personal,
      cases: new PrismaCaseRepository(prisma, personal),
      caseQueries: new PrismaCaseQueries(prisma, personal),
      imports: new PrismaCaseImportRepository(prisma, personal),
      preferences: new PrismaCreditorPreferencesStore(prisma),
      wallet,
      documents: new MemoryDocuments(),
      files: new MemoryFiles(),
      directory,
      creditorProfiles: new MemoryCreditorProfiles(),
      spreadsheets: new MemorySpreadsheets(),
      ids: new UuidV7Generator(),
      notifier,
      amicable,
      documentCancellation: new MemoryDocumentCancellation(),
      debtorAccess: {
        store: new PrismaDebtorAccessStore(prisma),
        reader: new PrismaDebtorCaseReader(prisma),
        journal: new PrismaDebtorAccessJournal(prisma),
        secrets: new FakeDebtorSecrets(),
        baseUrl: 'https://ksp.bj/recouvrement',
      },
    });
    for (const [id, stored] of caseWorld().deps.rules.rules) deps.rules.rules.set(id, stored);
    return { deps, useCases: createUseCases(deps), notifier, wallet };
  }

  /** Personnel à l'heure du monde (double authentification d'il y a une minute). */
  function staffAt<T>(
    deps: { clock: { current: Date } },
    userId: string,
    role: string,
    fn: () => Promise<T>,
  ) {
    const elapsed = Math.round((deps.clock.current.getTime() - NOW.getTime()) / 1000);
    return asStaff(userId, [role], fn, 60 - elapsed);
  }

  it('premier contact, échéancier hors barème accepté, signé, échéances déduites des encaissements', async () => {
    const { deps, useCases, notifier, wallet } = world();
    const created = await asCreditor(() =>
      useCases.createCase.execute({
        idempotencyKey: 'case-key-amicable-1',
        input: caseInput({ evidenceFileIds: ['0192f1c4-0000-7000-8000-0000000f0a01'] }),
      }),
    );
    const caseId = created.view.record.id;
    const prepared = await asCreditor(() =>
      useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: true }),
    );
    await useCases.recordMandateSignature.execute({
      eventId: '0192f1c4-0000-7000-8000-0000000a0a01',
      documentId: prepared.documentId,
      template: 'recovery_mandate',
      producerService: 'recovery',
      subjectType: 'recovery_case',
      subjectId: caseId,
      signerUserId: CREDITOR_ID,
      signedAt: NOW.toISOString(),
    });
    wallet.balances.set(CREDITOR_ID, 100_000);
    await asCreditor(() => useCases.payCaseFee.execute({ caseId, idempotencyKey: 'pay-key-amicable-1' }));
    await staffAt(deps, SUPERVISOR_ID, 'recovery_supervisor', () =>
      useCases.assessCase.execute({
        caseId,
        idempotencyKey: 'assess-amicable-1',
        decision: 'accept',
        note: '',
        agentUserId: AGENT_ID,
        rejectionReason: '',
      }),
    );
    const debtorId = (await deps.cases.find(caseId))!.debtors[0]!.id;

    // Premier contact : file, envoi, contact, journal et lien en base.
    expect(await useCases.watchAmicable.execute()).toMatchObject({
      noticesQueued: 1,
      messagesSent: 1,
      failed: 0,
    });
    expect(notifier.sent[0]).toMatchObject({
      message: 'mandate_notice',
      channel: 'email',
      email: 'compta@negoce.bj',
    });
    expect(await amicable.message(`notice:${caseId}`)).toMatchObject({
      status: 'sent',
      attempts: 1,
      channel: 'email',
    });
    const contacts = await prisma.contact.findMany({ where: { caseId } });
    expect(contacts).toEqual([
      expect.objectContaining({ channel: 'email', direction: 'outbound', byType: 'system' }),
    ]);
    const notice = await prisma.evidenceEntry.findFirst({ where: { caseId, action: 'message.notice' } });
    expect(notice).toMatchObject({ kind: 'message_sent', channel: 'email', deliveryStatus: 'sent' });
    expect(notice!.summary).not.toContain('negoce');
    expect(await prisma.debtorAccess.count({ where: { caseId, revokedAt: null } })).toBe(1);
    expect((await useCases.watchAmicable.execute()).messagesSent).toBe(0);

    // Échéancier hors barème : superviseur, puis créancier.
    const plan = await useCases.proposeDebtorPaymentPlan.execute({
      caseId,
      debtorId,
      idempotencyKey: 'plan-key-amicable-1',
      terms: { firstAmount: 30_000, firstDueDate: '2026-11-30', rhythm: 'monthly', installmentsCount: 5 },
      message: 'Je propose de payer chaque mois',
    });
    expect(await amicable.plan(plan.id)).toMatchObject({
      status: 'proposed',
      withinScale: false,
      version: 0,
    });
    const queue = await staffAt(deps, SUPERVISOR_ID, 'recovery_supervisor', () =>
      useCases.getMyWorkQueue.execute({ day: '' }),
    );
    expect(queue.map((item) => [item.kind, item.summary.summary.number])).toEqual([
      ['plan_to_validate', 'RC-000001'],
    ]);
    await staffAt(deps, SUPERVISOR_ID, 'recovery_supervisor', () =>
      useCases.approvePaymentPlan.execute({ planId: plan.id, decision: 'approve', note: '' }),
    );
    const decisions = await asCreditor(() => useCases.listMyDecisions.execute({ statuses: [], caseId: '' }));
    expect(decisions.items.map((item) => [item.decision.kind, item.caseNumber, item.plan?.status])).toEqual([
      ['plan_off_scale', 'RC-000001', 'pending_creditor'],
    ]);
    await asCreditor(() =>
      useCases.answerDecision.execute({
        decisionId: decisions.items[0]!.decision.id,
        idempotencyKey: 'answer-amicable-1',
        answer: 'approve',
        comment: '',
        fileIds: [],
      }),
    );
    const toSign = (await amicable.plan(plan.id))!;
    expect(toSign).toMatchObject({ status: 'pending_creditor', signatureRound: 1, version: 2 });

    const signature = {
      eventId: '0192f1c4-0000-7000-8000-0000000a0a02',
      documentId: toSign.documentId!,
      template: 'recovery_settlement_agreement',
      producerService: 'recovery',
      subjectType: 'recovery_case',
      subjectId: caseId,
      signedAt: NOW.toISOString(),
    };
    expect(await useCases.recordPlanSignature.execute(signature)).toBe('recorded');
    expect(await useCases.recordPlanSignature.execute(signature)).toBe('ignored');
    const record = (await deps.cases.find(caseId))!;
    expect(record.stage).toBe('payment_plan');
    expect(record.documents.find((document) => document.kind === 'payment_plan')).toMatchObject({
      documentId: toSign.documentId,
      visibleToDebtor: true,
    });
    const outbox = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox ORDER BY created_at, id`,
    );
    expect(outbox.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        'recovery.decision.requested',
        'recovery.plan.signed',
        'recovery.case.stage_changed',
      ]),
    );
    expect(
      (await pool.query(`SELECT 1 FROM processed_events WHERE event_id = $1`, [signature.eventId])).rowCount,
    ).toBe(1);

    // Encaissement du lot R3 (ligne écrite par lui) : échéance soldée, lue par la tâche.
    await pool.query(
      `INSERT INTO collections (id, case_id, source, reference, gross, allocated_costs, allocated_interests,
        allocated_principal, overpaid, commission_base, commission, net, stage_group, collected_at)
       VALUES ('0192f1c4-0000-7000-8000-00000000c0c1', $1, 'payment_link', 'payment:test-1', 30000, 0, 0, 30000,
        0, 30000, 3000, 27000, 'amicable', $2)`,
      [caseId, NOW],
    );
    expect(await amicable.collectedSince(caseId, toSign.createdAt)).toBe(30_000);
    await useCases.watchAmicable.execute();
    const installments = await prisma.installment.findMany({
      where: { planId: plan.id },
      orderBy: { rank: 'asc' },
    });
    expect(installments[0]).toMatchObject({ paid: 30_000, status: 'paid' });
    expect(installments[1]).toMatchObject({ paid: 0, status: 'upcoming' });
    expect(await amicable.message(`plan-confirmed:${plan.id}`)).toMatchObject({ status: 'sent' });
    // Le tableau de bord du créancier (lot R2) lit les mêmes échéances.
    const dashboard = await asCreditor(() => useCases.getMyDashboard.execute());
    expect(dashboard.upcomingInstallments[0]).toMatchObject({ caseNumber: 'RC-000001', amount: 144_000 });
  });

  it('verrous : version de l’échéancier, statut lu, index partiels, file réservée sans doublon', async () => {
    const { deps } = world();
    const caseRow = await prisma.recoveryCase.findFirstOrThrow();
    const [plan] = await amicable.plans(caseRow.id);
    const stale = noAmicableChanges();
    stale.plans.push({ row: { ...plan!, note: 'Concurrent' }, expected: plan!.version - 1 });
    expect(await amicable.commit({ changes: noChanges(), amicable: stale })).toBe('stale');

    // Un seul échéancier en cours d'accord par dossier (index partiel).
    const now = deps.clock.now();
    const pendingA = noAmicableChanges();
    pendingA.plans.push({
      row: {
        ...plan!,
        id: '0192f1c4-0000-7000-8000-0000000b0a01',
        status: 'proposed',
        signedAt: null,
        installments: [],
      },
      expected: null,
    });
    expect(await amicable.commit({ changes: noChanges(), amicable: pendingA })).toBe('saved');
    const pendingB = noAmicableChanges();
    pendingB.plans.push({
      row: {
        ...plan!,
        id: '0192f1c4-0000-7000-8000-0000000b0a02',
        status: 'proposed',
        signedAt: null,
        installments: [],
      },
      expected: null,
    });
    expect(await amicable.commit({ changes: noChanges(), amicable: pendingB })).toBe('stale');

    // Un message par clé ; deux réservations simultanées se partagent la file sans doublon.
    const debtorId = (await prisma.debtor.findFirstOrThrow({ where: { caseId: caseRow.id } })).id;
    const queued = noAmicableChanges();
    for (let index = 0; index < 4; index += 1) {
      queued.messages.push(
        queuedMessage(deps.ids, {
          caseId: caseRow.id,
          debtorId,
          message: 'reminder',
          purpose: 'manual',
          dedupeKey: `test:${index % 3}`,
          notBefore: now,
        }),
      );
    }
    expect(await amicable.commit({ changes: noChanges(), amicable: queued })).toBe('saved');
    expect(await prisma.debtorMessage.count({ where: { dedupeKey: { startsWith: 'test:' } } })).toBe(3);
    const lease = new Date(now.getTime() + 300_000);
    const [first, second] = await Promise.all([
      amicable.claimMessages(now, lease, 2),
      amicable.claimMessages(now, lease, 2),
    ]);
    const claimed = [...first!, ...second!].map((message) => message.dedupeKey);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.filter((key) => key.startsWith('test:')).length).toBeLessThanOrEqual(3);
    expect(await amicable.claimMessages(now, lease, 10)).toEqual([]);
  });
});
