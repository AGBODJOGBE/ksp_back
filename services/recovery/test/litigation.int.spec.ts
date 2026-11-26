import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlindIndex, FieldCipher, ReadinessRegistry } from '@ksp/platform';
import { Client, Pool } from 'pg';
import { noChanges } from '../src/application/cases/ports';
import { noLitigationWrites } from '../src/application/litigation/litigation.ports';
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
import { asCreditor, asStaff, CREDITOR_ID, makeDeps, NOW } from '../src/application/testing/fakes';
import {
  ACT_FILE,
  asPartner,
  BAILIFF_USER_ID,
  partnerInput,
  PROOF_FILE,
} from '../src/application/testing/litigation-scenarios';
import { MemoryPaymentLinks, MoneyWallet } from '../src/application/testing/money-fakes';
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
import { PrismaLitigationStore } from '../src/infrastructure/persistence/prisma-litigation.store';
import { PrismaMoneyStore } from '../src/infrastructure/persistence/prisma-money.store';
import { PrismaAuditLog } from '../src/infrastructure/persistence/prisma-settings.stores';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { KitPersonalData } from '../src/infrastructure/security/kit-personal-data';
import { UuidV7Generator } from '../src/infrastructure/system/system';

/**
 * Contentieux contre un vrai PostgreSQL (lot R5) : référentiel des partenaires (coordonnées chiffrées,
 * compte unique), mise en demeure et sa remise, proposition de l'huissier par la tâche, devis et
 * décision du lot R4 écrits ensemble, provision payée, assignation (index partiel, pièces rendues
 * visibles), accès du partenaire, actes et consommation de la provision, encaissement déclaré, journal
 * de preuve exporté, chiffres des partenaires, arrêt du dossier. Schéma jetable ; ignoré sans
 * TEST_DATABASE_URL.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const LEGAL_ID = '0192f1c4-0000-7000-8000-000000001e9b';

describeWithDatabase('contentieux (PostgreSQL)', () => {
  const schema = `recovery_litigation_test_${Date.now()}`;
  let pool: Pool;
  let prisma: PrismaService;
  // Une seule clé temporaire pour tous les mondes : la tâche relit les dossiers des autres tests.
  const personal = new KitPersonalData(
    FieldCipher.fromConfig(undefined, 'test', 'RECOVERY_PII_ENCRYPTION_KEYS'),
    BlindIndex.fromConfig(undefined, 'test', 'RECOVERY_BLIND_INDEX_KEYS'),
  );

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

  /**
   * Monde de test sur la base. Le portefeuille simulé numérote ses débits à partir de 1 : `offset`
   * débits blancs évitent qu'un second monde réutilise une référence déjà enregistrée (colonne unique).
   */
  async function world(offset = 0) {
    const prepaid = new MemoryWallet();
    const directory = new MemoryDirectory();
    directory.users.set(CREDITOR_ID, 'Awa Dossou');
    const litigation = new PrismaLitigationStore(prisma, personal);
    const deps = makeDeps({
      personalData: personal,
      cases: new PrismaCaseRepository(prisma, personal),
      caseQueries: new PrismaCaseQueries(prisma, personal),
      imports: new PrismaCaseImportRepository(prisma, personal),
      preferences: new PrismaCreditorPreferencesStore(prisma),
      audit: new PrismaAuditLog(prisma),
      wallet: new MoneyWallet(prepaid),
      paymentLinks: new MemoryPaymentLinks(),
      documents: new MemoryDocuments(),
      files: new MemoryFiles(),
      directory,
      creditorProfiles: new MemoryCreditorProfiles(),
      spreadsheets: new MemorySpreadsheets(),
      ids: new UuidV7Generator(),
      notifier: new CapturingNotifier(),
      amicable: new PrismaAmicableStore(prisma, personal),
      money: new PrismaMoneyStore(prisma, personal),
      litigation,
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
    for (let index = 0; index < offset; index += 1) {
      await prepaid.debit({
        holder: { type: 'user', id: 'seed' },
        amount: 0,
        objectType: 'seed',
        objectId: 'seed',
        idempotencyKey: `seed-${index}`,
        description: 'seed',
      });
    }
    return { deps, useCases: createUseCases(deps), prepaid, litigation };
  }

  type World = Awaited<ReturnType<typeof world>>;

  function at(w: World, instant: string) {
    w.deps.clock.current = new Date(instant);
  }

  /** Personnel à l'heure du monde (double authentification d'il y a une minute). */
  function staffAt<T>(w: World, userId: string, role: string, fn: () => Promise<T>) {
    const elapsed = Math.round((w.deps.clock.current.getTime() - NOW.getTime()) / 1000);
    return asStaff(userId, [role], fn, 60 - elapsed);
  }
  const legal = <T>(w: World, fn: () => Promise<T>) => staffAt(w, LEGAL_ID, 'legal_officer', fn);

  async function caseAtFormalNotice(w: World, suffix: string) {
    const created = await asCreditor(() =>
      w.useCases.createCase.execute({
        idempotencyKey: `case-key-litigation-${suffix}`,
        input: caseInput({ evidenceFileIds: [`0192f1c4-0000-7000-8000-0000000f0b0${suffix}`] }),
      }),
    );
    const caseId = created.view.record.id;
    const prepared = await asCreditor(() =>
      w.useCases.prepareMandate.execute({ caseId, duplicatesAcknowledged: true }),
    );
    await w.useCases.recordMandateSignature.execute({
      eventId: `0192f1c4-0000-7000-8000-0000000b0a0${suffix}`,
      documentId: prepared.documentId,
      template: 'recovery_mandate',
      producerService: 'recovery',
      subjectType: 'recovery_case',
      subjectId: caseId,
      signerUserId: CREDITOR_ID,
      signedAt: NOW.toISOString(),
    });
    w.prepaid.balances.set(CREDITOR_ID, 200_000);
    await asCreditor(() =>
      w.useCases.payCaseFee.execute({ caseId, idempotencyKey: `pay-litigation-${suffix}` }),
    );
    await staffAt(w, SUPERVISOR_ID, 'recovery_supervisor', () =>
      w.useCases.assessCase.execute({
        caseId,
        idempotencyKey: `assess-litigation-${suffix}`,
        decision: 'accept',
        note: '',
        agentUserId: '',
        rejectionReason: '',
      }),
    );
    for (const toStage of ['amicable', 'formal_notice']) {
      await staffAt(w, SUPERVISOR_ID, 'recovery_supervisor', () =>
        w.useCases.changeCaseStage.execute({
          caseId,
          toStage,
          reason: 'Relances sans effet',
          skipReason: '',
        }),
      );
    }
    return caseId;
  }

  it('du référentiel à l’arrêt du dossier : mise en demeure, devis, provision, huissier, actes', async () => {
    const w = await world();
    const caseId = await caseAtFormalNotice(w, '1');

    // Référentiel : coordonnées chiffrées en base, compte partenaire unique.
    const created = await legal(w, () =>
      w.useCases.createPartner.execute({ idempotencyKey: 'partner-int-1', input: partnerInput() }),
    );
    const partnerId = created.partner.id;
    const raw = await pool.query('SELECT contacts_enc, status, office FROM partners WHERE id = $1', [
      partnerId,
    ]);
    expect(raw.rows[0].status).toBe('pending_verification');
    expect(raw.rows[0].contacts_enc).not.toContain('97000555');
    expect(raw.rows[0].contacts_enc).not.toContain('adjovi.bj');
    const active = await legal(w, () =>
      w.useCases.updatePartner.execute({ partnerId, input: null, status: 'active', statusReason: '' }),
    );
    expect(active.partner).toMatchObject({
      status: 'active',
      phones: ['+2290197000555'],
      email: 'etude@adjovi.bj',
    });
    expect(
      await w.litigation.savePartner(
        { ...active.partner, id: '0192f1c4-0000-7000-8000-00000000dd01' },
        null,
        {
          actorId: LEGAL_ID,
          action: 'partner.created',
          at: NOW,
        },
      ),
    ).toBe('duplicate');

    // Mise en demeure, remise, délai écoulé : l'huissier est proposé par la tâche.
    const notice = await legal(w, () =>
      w.useCases.issueFormalNotice.execute({ caseId, idempotencyKey: 'notice-int-1', deadlineDays: 15 }),
    );
    at(w, '2026-11-21T09:00:00.000Z');
    await legal(w, () =>
      w.useCases.recordNoticeDelivery.execute({
        caseId,
        noticeId: notice.notice.id,
        deliveryMethod: 'bailiff',
        deliveredAt: '2026-11-21T08:00:00.000Z',
        proofFileId: PROOF_FILE,
      }),
    );
    expect(await w.litigation.notice(notice.notice.id)).toMatchObject({
      deliveryMethod: 'bailiff',
      deadlineAt: new Date('2026-12-06T08:00:00.000Z'),
      deliveredBy: LEGAL_ID,
    });
    expect((await w.deps.amicable.message(`formal-notice:${notice.notice.id}`))?.purpose).toBe(
      'formal_notice',
    );
    at(w, '2026-12-07T09:00:00.000Z');
    expect(await w.litigation.expiredNotices(w.deps.clock.current, null, 10)).toHaveLength(1);
    expect((await w.useCases.watchLitigation.execute()).escalationsProposed).toBe(1);
    expect((await w.useCases.watchLitigation.execute()).escalationsProposed).toBe(0);

    // Devis et décision du lot R4 écrits ensemble ; accord du créancier : provision, étape huissier.
    const escalation = await legal(w, () =>
      w.useCases.requestEscalation.execute({
        caseId,
        idempotencyKey: 'quote-int-1',
        stage: 'bailiff',
        partnerId,
        lines: [{ label: 'Sommation de payer', amount: 50_000 }],
        validUntil: '2026-12-31T00:00:00.000Z',
        note: '',
      }),
    );
    const decisionRow = await pool.query('SELECT type, status, payload FROM decisions WHERE id = $1', [
      escalation.decision.decision.id,
    ]);
    expect(decisionRow.rows[0]).toMatchObject({
      type: 'bailiff_escalation',
      status: 'pending',
      payload: { feeQuoteId: escalation.quote.quote.id },
    });
    const answered = await asCreditor(() =>
      w.useCases.answerDecision.execute({
        decisionId: escalation.decision.decision.id,
        idempotencyKey: 'answer-int-1',
        answer: 'approve',
        comment: '',
        fileIds: [],
      }),
    );
    expect(answered.view.record.stage).toBe('bailiff');
    expect(await w.litigation.provisions(caseId)).toEqual([
      expect.objectContaining({
        amount: 50_000,
        consumed: 0,
        status: 'paid',
        feeQuoteId: escalation.quote.quote.id,
      }),
    ]);
    expect((await w.litigation.feeQuote(escalation.quote.quote.id))?.status).toBe('accepted');

    // Assignation : une seule active par dossier (index partiel), pièces de la mission visibles.
    const assignment = await legal(w, () =>
      w.useCases.assignPartner.execute({ caseId, partnerId, note: 'Mission urgente' }),
    );
    const visible = await pool.query(
      'SELECT kind, visible_to_partner FROM case_documents WHERE case_id = $1 ORDER BY kind',
      [caseId],
    );
    expect(Object.fromEntries(visible.rows.map((row) => [row.kind, row.visible_to_partner]))).toMatchObject({
      evidence: true,
      mandate: true,
      formal_notice: true,
      notice_delivery_proof: true,
      fee_quote: false,
    });
    const duplicate = noLitigationWrites();
    duplicate.assignments.push({
      row: { ...assignment.assignment, id: '0192f1c4-0000-7000-8000-00000000dd02' },
      expected: null,
    });
    expect(await w.litigation.commit({ changes: noChanges(), litigation: duplicate })).toBe('stale');

    // Accès du partenaire, acte et consommation de la provision (dépassement signalé).
    const file = await asPartner(BAILIFF_USER_ID, () =>
      w.useCases.getMyAssignment.execute({ assignmentId: assignment.assignment.id }),
    );
    expect(file.documents.every((document) => document.visibleToPartner)).toBe(true);
    expect(file.caseView.record.debtors[0]?.legalName).toBe('SARL Bénin Négoce');
    const act = await asPartner(BAILIFF_USER_ID, () =>
      w.useCases.recordLegalAct.execute({
        assignmentId: assignment.assignment.id,
        idempotencyKey: 'act-int-0001',
        type: 'summons_to_pay',
        actDate: '2026-12-07',
        cost: 65_000,
        fileId: ACT_FILE,
        note: 'Remise à personne',
        nextStepDate: '2027-01-10',
      }),
    );
    expect(await w.litigation.act(act.id)).toMatchObject({ cost: 65_000, nextStepDate: '2027-01-10' });
    expect((await w.litigation.provisions(caseId))[0]?.consumed).toBe(50_000);
    const listed = await legal(w, () =>
      w.useCases.listPartners.execute({ kind: 'bailiff', statuses: ['active'], communeKey: 'cotonou' }),
    );
    expect(listed.items[0]?.stats).toMatchObject({ openAssignments: 1, closedAssignments: 0 });

    // Encaissement déclaré par le partenaire : en attente de la finance.
    const declared = await asPartner(BAILIFF_USER_ID, () =>
      w.useCases.declarePartnerCollection.execute({
        assignmentId: assignment.assignment.id,
        idempotencyKey: 'collect-int-1',
        amount: 80_000,
        receivedOn: '2026-12-07',
        proofFileId: '',
        note: '',
      }),
    );
    expect(declared.payment).toMatchObject({ source: 'partner', status: 'pending_approval', partnerId });

    // Journal de preuve exporté, sans entrées internes, ajouté aux pièces.
    const exported = await legal(w, () =>
      w.useCases.exportCaseJournal.execute({ caseId, idempotencyKey: 'export-int-1' }),
    );
    expect(await w.litigation.notices(caseId, 'evidence_log')).toEqual([
      expect.objectContaining({ documentId: exported.documentId, signedBy: LEGAL_ID }),
    ]);
    const log = await w.litigation.evidenceLog(caseId);
    expect(log.every((entry) => !entry.internal)).toBe(true);
    expect(log.map((entry) => entry.occurredAt.getTime())).toEqual(
      [...log.map((entry) => entry.occurredAt.getTime())].sort((a, b) => a - b),
    );

    // Arrêt par le créancier : clos, mission terminée, chiffres du partenaire à jour.
    const stopped = await asCreditor(() =>
      w.useCases.stopCase.execute({ caseId, reason: 'Le créancier renonce' }),
    );
    expect(stopped.view.record).toMatchObject({ status: 'closed', closureReason: 'abandoned_by_creditor' });
    expect((await w.litigation.assignment(assignment.assignment.id))?.status).toBe('completed');
    const stats = await w.litigation.partnerStats([partnerId]);
    expect(stats.get(partnerId)).toMatchObject({
      openAssignments: 0,
      closedAssignments: 1,
      successfulAssignments: 0,
    });
  });

  it('expire un devis sans réponse : décision et devis expirés, dossier clos par le service de clôture', async () => {
    const w = await world(100);
    const caseId = await caseAtFormalNotice(w, '2');
    const created = await legal(w, () =>
      w.useCases.createPartner.execute({
        idempotencyKey: 'partner-int-2',
        input: partnerInput({ userId: '', verificationFileId: '0192f1c4-0000-7000-8000-0000000fe0b2' }),
      }),
    );
    await legal(w, () =>
      w.useCases.updatePartner.execute({
        partnerId: created.partner.id,
        input: null,
        status: 'active',
        statusReason: '',
      }),
    );
    const notice = await legal(w, () =>
      w.useCases.issueFormalNotice.execute({ caseId, idempotencyKey: 'notice-int-2', deadlineDays: 8 }),
    );
    await legal(w, () =>
      w.useCases.recordNoticeDelivery.execute({
        caseId,
        noticeId: notice.notice.id,
        deliveryMethod: 'email',
        deliveredAt: '2026-11-20T09:00:00.000Z',
        proofFileId: '0192f1c4-0000-7000-8000-0000000fe0b3',
      }),
    );
    at(w, '2026-11-29T09:00:00.000Z');
    const escalation = await legal(w, () =>
      w.useCases.requestEscalation.execute({
        caseId,
        idempotencyKey: 'quote-int-2',
        stage: 'bailiff',
        partnerId: created.partner.id,
        lines: [{ label: 'Sommation', amount: 30_000 }],
        validUntil: '2026-12-02T00:00:00.000Z',
        note: '',
      }),
    );
    at(w, '2026-12-02T09:00:00.000Z');
    expect((await w.useCases.watchAmicable.execute()).decisionsExpired).toBe(1);
    expect((await w.deps.cases.find(caseId))?.closureReason).toBe('abandoned_by_creditor');
    expect((await w.deps.amicable.decision(escalation.decision.decision.id))?.status).toBe('expired');
    expect((await w.litigation.feeQuote(escalation.quote.quote.id))?.status).toBe('expired');
    const closure = await pool.query(
      'SELECT closed_by_type, closure_completed_at FROM recovery_cases WHERE id = $1',
      [caseId],
    );
    expect(closure.rows[0].closed_by_type).toBe('system');
    expect(closure.rows[0].closure_completed_at).not.toBeNull();
  });
});
