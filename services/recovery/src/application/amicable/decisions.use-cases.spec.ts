import {
  activeCase,
  type AmicableWorld,
  amicableWorld,
  asAgent,
  asLegal,
  asSupervisor,
  caseOf,
  eventsOf,
} from '../testing/amicable-scenarios';
import { asOtherCreditor, FILE_2, FILE_3 } from '../testing/case-scenarios';
import { asCreditor, rejection } from '../testing/fakes';

const B2B_WITH_DISCOUNT = {
  acceptsPaymentPlan: true,
  maxDurationMonths: 12,
  minFirstPaymentBps: 1_000,
  firstPaymentWithinDays: 15,
  minInstallment: 25_000,
  maxDiscountBps: 1_000,
};

describe('décisions du créancier et étapes (UC-RC-06, R-PR-03, R-PR-05)', () => {
  let world: AmicableWorld;
  let caseId: string;

  beforeEach(async () => {
    world = amicableWorld();
    caseId = (await activeCase(world)).id;
  });

  const settle = (payNow: number, key = 'settle-0001', id = caseId) =>
    asAgent(world, () =>
      world.useCases.proposeSettlement.execute({
        caseId: id,
        idempotencyKey: key,
        payNow,
        validUntil: '2026-12-05',
        note: '',
      }),
    );
  const answer = (decisionId: string, value: string, key = 'answer-0001', fileIds: string[] = []) =>
    asCreditor(() =>
      world.useCases.answerDecision.execute({
        decisionId,
        idempotencyKey: key,
        answer: value,
        comment: '',
        fileIds,
      }),
    );
  const changeStage = (toStage: string, skipReason = '') =>
    world.useCases.changeCaseStage.execute({ caseId, toStage, reason: 'Relances sans effet', skipReason });

  describe('remise pour paiement immédiat (ProposeSettlement)', () => {
    it('dans le barème du créancier, offerte au débiteur ; une nouvelle remise remplace la précédente', async () => {
      const generous = await activeCase(world, 'case-key-0002', {
        claims: [{ reference: 'F-88', amount: 500_000, dueDate: '2026-10-01', description: '' }],
        evidenceFileIds: [FILE_2],
        planScale: B2B_WITH_DISCOUNT,
      });
      const first = await settle(450_000, 'settle-0001', generous.id);
      expect(first).toMatchObject({
        status: 'proposed',
        waived: 50_000,
        discountBps: 1_000,
        withinScale: true,
      });
      expect(await settle(450_000, 'settle-0001', generous.id)).toEqual(first);
      expect(eventsOf(world, 'recovery.decision.requested')).toEqual([]);
      const second = await settle(460_000, 'settle-0002', generous.id);
      expect(second.status).toBe('proposed');
      expect(world.store.settlementRows.get(first.id)!.status).toBe('expired');
    });

    it('au-delà du barème, décision du créancier : acceptée, une seule fois', async () => {
      const settlement = await settle(675_000);
      expect(settlement).toMatchObject({ status: 'pending_creditor', withinScale: false, payNow: 675_000 });
      const [requested] = eventsOf(world, 'recovery.decision.requested');
      expect(requested!.payload).toMatchObject({
        kind: 'settlement_discount',
        expiresAt: '2026-11-23T09:00:00.000Z',
      });
      expect((await rejection(settle(650_000, 'settle-0002'))).code).toBe('RECOVERY_INVALID_TRANSITION');

      const list = await asCreditor(() =>
        world.useCases.listMyDecisions.execute({ statuses: ['pending'], caseId }),
      );
      expect(list.items).toEqual([
        expect.objectContaining({ settlement: expect.objectContaining({ id: settlement.id }), plan: null }),
      ]);
      expect(
        (await asOtherCreditor(() => world.useCases.listMyDecisions.execute({ statuses: [], caseId: '' })))
          .items,
      ).toEqual([]);
      const decisionId = list.items[0]!.decision.id;
      expect(
        (
          await rejection(
            asOtherCreditor(() =>
              world.useCases.answerDecision.execute({
                decisionId,
                idempotencyKey: 'answer-0009',
                answer: 'approve',
                comment: '',
                fileIds: [],
              }),
            ),
          )
        ).code,
      ).toBe('RECOVERY_DECISION_NOT_FOUND');
      const answered = await answer(decisionId, 'approve');
      expect(answered.decision).toMatchObject({
        decision: { status: 'approved' },
        settlement: { status: 'accepted' },
      });
      expect(world.deps.cases.evidence.at(-1)).toMatchObject({
        kind: 'decision',
        actor: { type: 'creditor' },
      });
      expect(await rejection(answer(decisionId, 'reject', 'answer-0002'))).toMatchObject({
        code: 'RECOVERY_DECISION_CLOSED',
      });
    });

    it('refuse un montant sans remise et une validité au-delà de 30 jours', async () => {
      expect(await rejection(settle(750_000))).toMatchObject({ details: { field: 'amount' } });
      const late = await rejection(
        asAgent(world, () =>
          world.useCases.proposeSettlement.execute({
            caseId,
            idempotencyKey: 'settle-0003',
            payNow: 700_000,
            validUntil: '2027-01-31',
            note: '',
          }),
        ),
      );
      expect(late).toMatchObject({ details: { field: 'validUntil' } });
    });
  });

  describe('changement d’étape (ChangeCaseStage)', () => {
    it('escalade validée par le superviseur : tracée, publiée, auditée', async () => {
      const view = await asSupervisor(world, () => changeStage('amicable'));
      expect(view.record.stage).toBe('amicable');
      expect(view.stageHistory.at(-1)).toMatchObject({
        from: 'notice',
        to: 'amicable',
        reason: 'Relances sans effet',
      });
      expect(eventsOf(world, 'recovery.case.stage_changed').at(-1)!.payload).toMatchObject({
        fromStage: 'notice',
        toStage: 'amicable',
        changedBy: 'staff',
        skipReason: null,
      });
      expect(world.deps.cases.audit.at(-1)).toMatchObject({
        action: 'case.stage_changed',
        details: { from: 'notice', to: 'amicable' },
      });
      await asSupervisor(world, () => changeStage('formal_notice'));
      expect(await rejection(asSupervisor(world, () => changeStage('bailiff')))).toMatchObject({
        code: 'RECOVERY_CREDITOR_APPROVAL_REQUIRED',
      });
    });

    it('l’étape « échéancier » ne s’ouvre qu’à la signature ; un chargé ne change pas d’étape', async () => {
      expect((await rejection(asSupervisor(world, () => changeStage('payment_plan')))).code).toBe(
        'RECOVERY_INVALID_TRANSITION',
      );
      expect((await rejection(asAgent(world, () => changeStage('amicable')))).code).toBe('AUTH_FORBIDDEN');
    });

    it('saut d’étape (R-PR-03) : demandé par le juriste, exécuté à l’accord du créancier', async () => {
      expect(
        (await rejection(asSupervisor(world, () => changeStage('formal_notice', 'asset_flight_risk')))).code,
      ).toBe('AUTH_FORBIDDEN');
      const pending = await rejection(
        asLegal(world, () => changeStage('formal_notice', 'asset_flight_risk')),
      );
      expect(pending).toMatchObject({
        code: 'RECOVERY_CREDITOR_APPROVAL_REQUIRED',
        details: { decisionId: expect.any(String), expiresAt: '2026-12-05T09:00:00.000Z' },
      });
      const again = await rejection(asLegal(world, () => changeStage('formal_notice', 'asset_flight_risk')));
      expect(again.details['decisionId']).toBe(pending.details['decisionId']);
      expect(caseOf(world, caseId).stage).toBe('notice');
      expect(eventsOf(world, 'recovery.decision.requested').map((event) => event.payload)).toEqual([
        expect.objectContaining({ kind: 'stage_skip', decisionId: pending.details['decisionId'] }),
      ]);
      await answer(String(pending.details['decisionId']), 'approve');
      expect(caseOf(world, caseId)).toMatchObject({ stage: 'formal_notice', highestStage: 'formal_notice' });
      expect(eventsOf(world, 'recovery.case.stage_changed').at(-1)!.payload).toMatchObject({
        fromStage: 'notice',
        toStage: 'formal_notice',
        skipReason: 'asset_flight_risk',
      });
      expect((await rejection(asLegal(world, () => changeStage('bailiff', 'prescription_near')))).code).toBe(
        'RECOVERY_STAGE_SKIP_NOT_ALLOWED',
      );
    });
  });

  it('contestation : réponse du créancier avec ses pièces, la suite au juriste', async () => {
    const decisionId = '0192f1c4-0000-7000-8000-00000000d1d1';
    world.store.decisionRows.set(decisionId, {
      id: decisionId,
      caseId,
      kind: 'dispute_response',
      status: 'pending',
      payload: {},
      requestedBy: null,
      requestedAt: world.deps.clock.current,
      expiresAt: new Date('2026-11-30T09:00:00.000Z'),
      decidedAt: null,
      decidedBy: null,
      answer: null,
    });
    expect((await rejection(answer(decisionId, 'approve'))).code).toBe('RECOVERY_INVALID_TRANSITION');
    const answered = await answer(decisionId, 'answer', 'answer-0003', [FILE_3]);
    expect(answered.decision.decision).toMatchObject({
      status: 'answered',
      answer: { answer: 'answer', fileIds: [FILE_3], idempotencyKey: 'answer-0003' },
    });
    expect(world.files.subjects.get(FILE_3)).toEqual({ type: 'recovery_case', id: caseId });
  });
});
