import {
  caseWorld,
  type CaseWorld,
  createDraft,
  FILE_2,
  signMandate,
  submittedCase,
  SUPERVISOR_ID,
} from '../testing/case-scenarios';
import { asStaff, CREDITOR_ID, NOW } from '../testing/fakes';
import { caseFeeKey, studyFeeKey } from './case-fees';

const DAY = 86_400_000;

describe('tâche des échéances des dossiers (R-SD-04, 4.4)', () => {
  let world: CaseWorld;

  beforeEach(() => {
    world = caseWorld();
  });

  const later = (days: number) => {
    world.deps.clock.current = new Date(NOW.getTime() + days * DAY);
  };
  const run = () => world.useCases.watchCaseDeadlines.execute();

  it('supprime un brouillon non payé après 7 jours, journal compris, avec une trace d’audit', async () => {
    const draft = await createDraft(world);
    const caseId = draft.view.record.id;
    later(6);
    expect((await run()).deleted).toBe(0);
    later(7);
    expect(await run()).toMatchObject({ deleted: 1, failed: 0 });
    expect(world.deps.cases.cases.has(caseId)).toBe(false);
    expect(world.deps.cases.evidence.filter((entry) => entry.caseId === caseId)).toEqual([]);
    expect(world.deps.cases.audit).toEqual([
      expect.objectContaining({
        actorId: 'system',
        action: 'case.unpaid_deleted',
        details: { number: 'RC-000001', status: 'draft' },
      }),
    ]);
  });

  it('mandat signé mais frais impayés : supprimé aussi ; un dossier payé ne l’est jamais', async () => {
    const unpaid = await createDraft(world);
    await signMandate(world, unpaid.view.record.id);
    const paid = await submittedCase(world, 'case-key-0002', {
      claims: [{ reference: 'F-55', amount: 100_000, dueDate: '2026-10-01', description: '' }],
      evidenceFileIds: [FILE_2],
    });
    later(8);
    expect(await run()).toMatchObject({ deleted: 1 });
    expect(world.deps.cases.cases.has(unpaid.view.record.id)).toBe(false);
    expect(world.deps.cases.cases.get(paid.record.id)!.status).toBe('under_review');
  });

  it('débit resté sans réponse : rapproché par la même clé avant toute suppression', async () => {
    const draft = await createDraft(world);
    const caseId = draft.view.record.id;
    await signMandate(world, caseId);
    world.wallet.balances.set(CREDITOR_ID, 30_000);
    // Le débit a abouti chez wallet, mais la réponse s'est perdue : la marque est restée.
    await world.wallet.debit({
      holder: { type: 'user', id: CREDITOR_ID },
      amount: 25_000,
      objectType: 'recovery_case_fee',
      objectId: caseId,
      idempotencyKey: caseFeeKey(caseId),
      description: 'Frais de dossier RC-000001',
    });
    world.deps.cases.cases.get(caseId)!.fee.debitAttemptedAt = NOW;
    later(8);
    expect(await run()).toMatchObject({ reconciled: 1, deleted: 0 });
    expect(world.deps.cases.cases.get(caseId)).toMatchObject({ status: 'under_review' });
    expect(world.wallet.balances.get(CREDITOR_ID)).toBe(5_000);
    expect(world.deps.cases.events.map((event) => event.type)).toEqual(['recovery.case.submitted']);
  });

  it('marque sans débit chez wallet (solde insuffisant) : dossier supprimé', async () => {
    const draft = await createDraft(world);
    const caseId = draft.view.record.id;
    await signMandate(world, caseId);
    world.deps.cases.cases.get(caseId)!.fee.debitAttemptedAt = NOW;
    later(8);
    expect(await run()).toMatchObject({ reconciled: 0, deleted: 1 });
    expect(world.wallet.debits.size).toBe(0);
  });

  it('complément non fourni en 15 jours : classé « incomplete », frais remboursés moins le forfait', async () => {
    const submitted = await submittedCase(world);
    const caseId = submitted.record.id;
    await asStaff(SUPERVISOR_ID, ['recovery_supervisor'], () =>
      world.useCases.assessCase.execute({
        caseId,
        idempotencyKey: 'assess-info-0001',
        decision: 'request_info',
        note: 'RCCM du débiteur à fournir',
        agentUserId: '',
        rejectionReason: '',
      }),
    );
    later(14);
    expect((await run()).closed).toBe(0);
    later(15);
    expect(await run()).toMatchObject({ closed: 1, failed: 0 });
    const record = world.deps.cases.cases.get(caseId)!;
    expect(record).toMatchObject({
      status: 'rejected',
      rejectionReason: 'incomplete',
      fee: { refundedAt: world.deps.clock.current },
    });
    const refund = world.wallet.refunds.get(world.wallet.debits.get(caseFeeKey(caseId))!.transactionId);
    expect(refund!.reason).toBe('Dossier RC-000001 classé faute de complément');
    expect(world.wallet.debits.get(studyFeeKey(caseId))).toMatchObject({ amount: 5_000 });
    expect(world.deps.cases.events.at(-1)).toMatchObject({
      type: 'recovery.case.rejected',
      payload: { reason: 'incomplete', refundedAmount: { amount: 20_000, currency: 'XOF' } },
    });
    // Rien de plus au passage suivant.
    expect(await run()).toMatchObject({ closed: 0, settled: 0 });
  });

  it('sans règle de forfait d’étude : tout est remboursé', async () => {
    world = caseWorld({ studyFee: false });
    const submitted = await submittedCase(world);
    await asStaff(SUPERVISOR_ID, ['recovery_supervisor'], () =>
      world.useCases.assessCase.execute({
        caseId: submitted.record.id,
        idempotencyKey: 'assess-reject-0001',
        decision: 'reject',
        note: 'Débiteur introuvable',
        agentUserId: '',
        rejectionReason: 'debtor_unreachable',
      }),
    );
    expect(world.wallet.balances.get(CREDITOR_ID)).toBe(100_000);
    expect(world.wallet.debits.has(studyFeeKey(submitted.record.id))).toBe(false);
    expect(world.deps.cases.events.at(-1)!.payload).toMatchObject({ refundedAmount: { amount: 25_000 } });
  });
});
