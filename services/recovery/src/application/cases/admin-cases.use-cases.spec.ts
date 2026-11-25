import {
  caseInput,
  caseWorld,
  type CaseWorld,
  createDraft,
  FILE_2,
  LEGAL_ID,
  OTHER_AGENT_ID,
  submittedCase,
  SUPERVISOR_ID,
} from '../testing/case-scenarios';
import { AGENT_ID, asCreditor, asStaff, CREDITOR_ID, FINANCE_ID, NOW, rejection } from '../testing/fakes';
import { caseFeeKey, studyFeeKey } from './case-fees';

describe('recevabilité et back-office des dossiers (R2 : UC-RC-14, 14.6)', () => {
  let world: CaseWorld;

  beforeEach(() => {
    world = caseWorld();
  });

  const asSupervisor = <T>(fn: () => Promise<T>) => asStaff(SUPERVISOR_ID, ['recovery_supervisor'], fn);
  const assess = (
    caseId: string,
    decision: string,
    change: Partial<{
      note: string;
      agentUserId: string;
      rejectionReason: string;
      idempotencyKey: string;
    }> = {},
  ) =>
    asSupervisor(() =>
      world.useCases.assessCase.execute({
        caseId,
        idempotencyKey: change.idempotencyKey ?? `assess-${decision}-01`,
        decision,
        note: change.note ?? '',
        agentUserId: change.agentUserId ?? '',
        rejectionReason: change.rejectionReason ?? '',
      }),
    );

  describe('décision de recevabilité (AssessCase)', () => {
    it('recevable : actif à la notification, score, chargé affecté, événements et audit', async () => {
      const submitted = await submittedCase(world);
      const caseId = submitted.record.id;
      const view = await assess(caseId, 'accept', { agentUserId: AGENT_ID });
      expect(view.record).toMatchObject({
        status: 'active',
        stage: 'notice',
        highestStage: 'notice',
        acceptedAt: NOW,
        assignedAgentId: AGENT_ID,
      });
      expect(view.record.score!.value).toBeGreaterThan(0);
      expect(view.stageHistory).toEqual([
        expect.objectContaining({ from: null, to: 'notice', by: { type: 'agent', id: SUPERVISOR_ID } }),
      ]);
      const events = world.deps.cases.events.map((event) => event.type);
      expect(events).toEqual([
        'recovery.case.submitted',
        'recovery.case.accepted',
        'recovery.case.stage_changed',
      ]);
      expect(world.deps.cases.events[1]!.payload).toEqual({
        caseId,
        caseNumber: 'RC-000001',
        creditor: { type: 'user', id: CREDITOR_ID },
        kind: 'b2b',
        assignedAgentId: AGENT_ID,
        score: view.record.score!.value,
        acceptedAt: NOW.toISOString(),
      });
      expect(world.deps.cases.audit.map((entry) => entry.action)).toEqual(['case.accepted']);
      // Rejeu de la même clé : rien de plus.
      await assess(caseId, 'accept', { agentUserId: AGENT_ID });
      expect(world.deps.cases.events).toHaveLength(3);
      // Une autre décision sur un dossier déjà actif est refusée.
      const error = await rejection(assess(caseId, 'request_info', { note: 'Pièce manquante' }));
      expect(error).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION', details: { status: 'active' } });
    });

    it('complément demandé : motif obligatoire, délai de 15 jours, puis complément du créancier', async () => {
      const submitted = await submittedCase(world);
      const caseId = submitted.record.id;
      expect((await rejection(assess(caseId, 'request_info'))).details.field).toBe('note');
      const view = await assess(caseId, 'request_info', { note: 'Facture F-2026-002 illisible' });
      expect(view.record).toMatchObject({
        status: 'info_requested',
        reviewNote: 'Facture F-2026-002 illisible',
      });
      expect(view.nextDeadline).toEqual({
        kind: 'info_completion',
        dueAt: new Date(NOW.getTime() + 15 * 86_400_000),
      });
      expect(world.deps.cases.events.at(-1)).toEqual({
        type: 'recovery.case.info_requested',
        payload: {
          caseId,
          caseNumber: 'RC-000001',
          creditor: { type: 'user', id: CREDITOR_ID },
          completionDueAt: new Date(NOW.getTime() + 15 * 86_400_000).toISOString(),
          requestedAt: NOW.toISOString(),
        },
      });
      const completed = await asCreditor(() =>
        world.useCases.updateCase.execute({
          caseId,
          input: caseInput({ evidenceFileIds: [FILE_2] }),
          completionNote: 'Facture lisible jointe',
        }),
      );
      expect(completed.record).toMatchObject({
        status: 'under_review',
        completionNote: 'Facture lisible jointe',
        infoRequestedAt: null,
      });
      expect(completed.record.documents.map((document) => document.fileId)).toContain(FILE_2);
    });

    it('irrecevable : frais remboursés en entier puis forfait d’étude débité à part', async () => {
      const submitted = await submittedCase(world);
      const caseId = submitted.record.id;
      expect(world.wallet.balances.get(CREDITOR_ID)).toBe(75_000);
      const incomplete = await rejection(
        assess(caseId, 'reject', { rejectionReason: 'incomplete', note: 'Pas de réponse' }),
      );
      expect(incomplete.details.field).toBe('rejectionReason');
      const view = await assess(caseId, 'reject', {
        rejectionReason: 'prescribed',
        note: 'Créance prescrite',
      });
      expect(view.record).toMatchObject({
        status: 'rejected',
        rejectionReason: 'prescribed',
        reviewNote: 'Créance prescrite',
        fee: { refundedAt: NOW, studyFeeChargedAt: NOW },
      });
      expect(world.wallet.balances.get(CREDITOR_ID)).toBe(95_000);
      const debit = world.wallet.debits.get(caseFeeKey(caseId))!;
      expect(world.wallet.refunds.get(debit.transactionId)).toMatchObject({
        reason: 'Dossier RC-000001 refusé',
      });
      expect(world.wallet.debits.get(studyFeeKey(caseId))).toMatchObject({
        amount: 5_000,
        objectType: 'recovery_study_fee',
        objectId: caseId,
        description: "Forfait d'étude du dossier RC-000001",
      });
      expect(world.deps.cases.events.at(-1)).toMatchObject({
        type: 'recovery.case.rejected',
        payload: { reason: 'prescribed', refundedAmount: { amount: 20_000, currency: 'XOF' } },
      });
      expect(world.deps.cases.evidence.slice(-3).map((entry) => entry.action)).toEqual([
        'case.rejected',
        'fee.refunded',
        'fee.study_fee_charged',
      ]);
    });

    it('forfait d’étude en échec : refus enregistré, débit repris par la tâche avec la même clé', async () => {
      const submitted = await submittedCase(world);
      const caseId = submitted.record.id;
      world.wallet.balances.set(CREDITOR_ID, 0);
      const view = await assess(caseId, 'reject', { rejectionReason: 'no_evidence', note: 'Aucune preuve' });
      // Remboursement fait (25 000), forfait débité ensuite : le solde le permet.
      expect(view.record.fee).toMatchObject({ refundedAt: NOW, studyFeeChargedAt: NOW });
      const second = await submittedCase(world, 'case-key-0002', {
        claims: [{ reference: 'F-9', amount: 100_000, dueDate: '2026-10-01', description: '' }],
        evidenceFileIds: [FILE_2],
      });
      world.wallet.unavailable = 2;
      const pending = await assess(second.record.id, 'reject', {
        rejectionReason: 'other',
        note: 'Hors périmètre',
        idempotencyKey: 'assess-reject-02',
      });
      expect(pending.record.fee.refundedAt).toBeNull();
      world.wallet.unavailable = 0;
      const report = await world.useCases.watchCaseDeadlines.execute();
      expect(report).toMatchObject({ settled: 1, failed: 0 });
      expect((await world.deps.cases.find(second.record.id))!.fee).toMatchObject({
        refundedAt: NOW,
        studyFeeChargedAt: NOW,
      });
    });
  });

  describe('affectation et périmètre (AssignCase, ADR-060 point 13)', () => {
    it('un chargé ne voit que ses dossiers ; le juriste et la finance lisent tout ; hors périmètre : 404', async () => {
      const mine = await submittedCase(world);
      const other = await submittedCase(world, 'case-key-0002', {
        claims: [{ reference: 'F-77', amount: 100_000, dueDate: '2026-10-01', description: '' }],
        evidenceFileIds: [FILE_2],
      });
      await asSupervisor(() =>
        world.useCases.assignCase.execute({ caseId: mine.record.id, agentUserId: AGENT_ID }),
      );
      await asSupervisor(() =>
        world.useCases.assignCase.execute({ caseId: other.record.id, agentUserId: OTHER_AGENT_ID }),
      );
      const listAs = (userId: string, roles: string[], agent = '') =>
        asStaff(userId, roles, () =>
          world.useCases.listCases.execute({
            statuses: [],
            stages: [],
            kinds: [],
            assignedAgentId: agent,
            creditorId: '',
            partnerId: '',
            communeKey: '',
            search: '',
            idleDays: 0,
            prescriptionNear: false,
          }),
        );
      expect((await listAs(AGENT_ID, ['recovery_agent'])).items.map((item) => item.summary.id)).toEqual([
        mine.record.id,
      ]);
      expect((await listAs(AGENT_ID, ['recovery_agent'], OTHER_AGENT_ID)).total).toBe(0);
      expect((await listAs(LEGAL_ID, ['legal_officer'])).total).toBe(2);
      expect((await listAs(FINANCE_ID, ['finance_officer'])).total).toBe(2);
      const hidden = await rejection(
        asStaff(AGENT_ID, ['recovery_agent'], () =>
          world.useCases.getCase.execute({ caseId: other.record.id }),
        ),
      );
      expect(hidden.code).toBe('RECOVERY_CASE_NOT_FOUND');
      const forbidden = await rejection(
        asStaff(AGENT_ID, ['recovery_agent'], () =>
          world.useCases.assignCase.execute({ caseId: mine.record.id, agentUserId: AGENT_ID }),
        ),
      );
      expect(forbidden.code).toBe('AUTH_FORBIDDEN');
      expect(world.deps.cases.audit.filter((entry) => entry.action === 'case.assigned')).toHaveLength(2);
    });

    it('un brouillon ne s’affecte pas ; le créancier n’accède pas au back-office', async () => {
      const draft = await createDraft(world);
      const error = await rejection(
        asSupervisor(() =>
          world.useCases.assignCase.execute({ caseId: draft.view.record.id, agentUserId: AGENT_ID }),
        ),
      );
      expect(error).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION', details: { status: 'draft' } });
      const creditor = await rejection(
        asCreditor(() =>
          world.useCases.listCaseJournal.execute({
            caseId: draft.view.record.id,
            includeInternal: true,
          }),
        ),
      );
      expect(creditor.code).toBe('AUTH_FORBIDDEN');
    });
  });

  describe('fiche, journal et tableau de bord (GetCase, ListCaseJournal, GetRecoveryOverview)', () => {
    it('fiche : score provisoire pendant l’examen, injonction de payer, consultation tracée', async () => {
      const submitted = await submittedCase(world);
      const result = await asStaff(LEGAL_ID, ['legal_officer'], () =>
        world.useCases.getCase.execute({ caseId: submitted.record.id }),
      );
      expect(result.score!.breakdown).toMatchObject({ writtenAcknowledgment: 0, evidenceQuality: 60 });
      expect(result.score!.inputs).toMatchObject({
        debtAgeDays: 51,
        amountDue: 750_000,
        validContactCount: 3,
      });
      expect(result.injunctionEligible).toBe(true);
      expect(world.deps.audit.entries).toEqual([
        expect.objectContaining({ actorId: LEGAL_ID, action: 'case.viewed', entityId: submitted.record.id }),
      ]);
      const journal = await asStaff(LEGAL_ID, ['legal_officer'], () =>
        world.useCases.listCaseJournal.execute({ caseId: submitted.record.id, includeInternal: true }),
      );
      expect(journal.entries[0]!.entry.action).toBe('case.submitted');
    });

    it('tableau de bord : files d’attente, montants, taux par chargé', async () => {
      const first = await submittedCase(world);
      await submittedCase(world, 'case-key-0002', {
        claims: [{ reference: 'F-77', amount: 250_000, dueDate: '2026-10-01', description: '' }],
        evidenceFileIds: [FILE_2],
      });
      await assess(first.record.id, 'accept', { agentUserId: AGENT_ID });
      world.deps.caseQueries.collected.set(first.record.id, [{ amount: 75_000, stageGroup: 'amicable' }]);
      world.directory.users.set(AGENT_ID, 'Bio Sacca');
      const overview = await asSupervisor(() =>
        world.useCases.getRecoveryOverview.execute({ communeKey: '' }),
      );
      expect(overview.figures).toMatchObject({
        reviewQueue: 1,
        entrusted: 1_000_000,
        recovered: 75_000,
        casesByStage: [{ stage: 'notice', count: 1 }],
      });
      expect(overview.recoveryRateBps).toBe(750);
      expect(overview.agents).toEqual([
        { agentId: AGENT_ID, name: 'Bio Sacca', openCases: 1, recovered: 75_000, recoveryRateBps: 1_000 },
      ]);
      const agentView = await asStaff(AGENT_ID, ['recovery_agent'], () =>
        world.useCases.getRecoveryOverview.execute({ communeKey: '' }),
      );
      expect(agentView.figures.reviewQueue).toBe(0);
    });
  });
});
