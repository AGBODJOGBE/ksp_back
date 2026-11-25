import {
  activeCase,
  type AmicableWorld,
  amicableWorld,
  asAgent,
  asSupervisor,
  at,
  caseOf,
  eventsOf,
} from '../testing/amicable-scenarios';
import { caseInput, FILE_2, FILE_3 } from '../testing/case-scenarios';
import { asCreditor, NOW, rejection } from '../testing/fakes';
import { type PlanRecord } from './amicable.ports';

/** 750 000 FCFA : 75 000 le 30 novembre, puis 5 mensualités de 135 000 (dans le barème B2B). */
const IN_SCALE = { firstAmount: 75_000, firstDueDate: '2026-11-30', rhythm: 'monthly', installmentsCount: 5 };
/** Premier versement sous les 10 % du barème : hors barème. */
const OFF_SCALE = { ...IN_SCALE, firstAmount: 30_000 };

let events = 0;
const nextEventId = () => {
  events += 1;
  return `0192f1c4-0000-7000-8000-${(0xe000 + events).toString(16).padStart(12, '0')}`;
};

describe('échéanciers (UC-RC-12, 17 ; R-EC-01 à 03)', () => {
  let world: AmicableWorld;
  let caseId: string;
  let debtorId: string;

  beforeEach(async () => {
    world = amicableWorld();
    const record = await activeCase(world);
    caseId = record.id;
    debtorId = record.debtors[0]!.id;
  });

  const debtorProposes = (terms = IN_SCALE, key = 'plan-key-0001') =>
    world.useCases.proposeDebtorPaymentPlan.execute({
      caseId,
      debtorId,
      idempotencyKey: key,
      terms,
      message: 'Je peux payer chaque mois',
    });

  const sign = (plan: PlanRecord, eventId = nextEventId()) =>
    world.useCases.recordPlanSignature.execute({
      eventId,
      documentId: plan.documentId!,
      template: 'recovery_settlement_agreement',
      producerService: 'recovery',
      subjectType: 'recovery_case',
      subjectId: caseId,
      signedAt: world.deps.clock.current.toISOString(),
    });

  it('simule dans le barème sans rien enregistrer', async () => {
    const inScale = await world.useCases.simulateDebtorPaymentPlan.execute({ caseId, terms: IN_SCALE });
    expect(inScale).toMatchObject({ total: 750_000, withinScale: true, violations: [] });
    expect(inScale.installments.map((i) => [i.rank, i.dueDate, i.amount, i.status])).toEqual([
      [1, '2026-11-30', 75_000, 'upcoming'],
      [2, '2026-12-30', 135_000, 'upcoming'],
      [3, '2027-01-30', 135_000, 'upcoming'],
      [4, '2027-02-28', 135_000, 'upcoming'],
      [5, '2027-03-30', 135_000, 'upcoming'],
      [6, '2027-04-30', 135_000, 'upcoming'],
    ]);
    const offScale = await world.useCases.simulateDebtorPaymentPlan.execute({ caseId, terms: OFF_SCALE });
    expect(offScale).toMatchObject({ withinScale: false, violations: ['first_payment'] });
    expect(world.store.planRows.size).toBe(0);
    expect(
      await rejection(
        world.useCases.simulateDebtorPaymentPlan.execute({ caseId, terms: { ...IN_SCALE, rhythm: 'daily' } }),
      ),
    ).toMatchObject({
      details: { field: 'terms.rhythm' },
    });
  });

  it('dans le barème : protocole produit et envoyé à la signature ; signé, l’échéancier vaut reconnaissance de dette', async () => {
    const promise = await asAgent(world, () =>
      world.useCases.recordPromise.execute({
        caseId,
        idempotencyKey: 'promise-0001',
        amount: 50_000,
        dueDate: '2026-11-27',
        note: '',
      }),
    );
    const plan = await debtorProposes();
    expect(plan).toMatchObject({
      status: 'proposed',
      withinScale: true,
      total: 750_000,
      proposedBy: { type: 'debtor', id: debtorId },
      signatureRound: 1,
      note: 'Je peux payer chaque mois',
    });
    const generated = world.documents.generated.get(`recovery:plan:${plan.id}:1`)!;
    expect(generated.id).toBe(plan.documentId);
    expect(generated.variables).toMatchObject({
      caseReference: 'RC-000001',
      creditor: { name: 'Awa Dossou' },
      debtor: { name: 'SARL Bénin Négoce', identification: '3201900000001' },
      agreedTotal: 750_000,
      graceDays: 5,
    });
    expect(generated.variables['installments']).toHaveLength(6);
    expect(world.documents.signatures.get(`recovery:plan-signature:${plan.documentId}`)).toMatchObject({
      documentId: plan.documentId,
    });
    expect(await debtorProposes()).toEqual(plan);
    expect(world.documents.generated.size).toBe(2);

    at(world, '2026-11-21T10:00:00.000Z');
    expect(await sign(plan, '0192f1c4-0000-7000-8000-00000000e999')).toBe('recorded');
    // Rejouée, la signature ne refait rien : l'échéancier n'attend plus de signature.
    expect(await sign(plan, '0192f1c4-0000-7000-8000-00000000e999')).toBe('ignored');
    const record = caseOf(world, caseId);
    expect(record.stage).toBe('payment_plan');
    expect(record.documents.at(-1)).toMatchObject({
      kind: 'payment_plan',
      documentId: plan.documentId,
      visibleToDebtor: true,
    });
    expect(world.store.planRows.get(plan.id)).toMatchObject({
      status: 'signed',
      signedAt: world.deps.clock.current,
    });
    expect(world.store.promiseRows.get(promise.id)!.status).toBe('cancelled');
    expect(eventsOf(world, 'recovery.plan.signed')).toEqual([
      {
        type: 'recovery.plan.signed',
        payload: expect.objectContaining({
          planId: plan.id,
          total: { amount: 750_000, currency: 'XOF' },
          installmentsCount: 6,
          firstDueDate: '2026-11-30',
          renegotiation: false,
          documentId: plan.documentId,
        }),
      },
    ]);
    expect(eventsOf(world, 'recovery.case.stage_changed').at(-1)!.payload).toMatchObject({
      fromStage: 'notice',
      toStage: 'payment_plan',
      changedBy: 'system',
    });
    expect([...world.store.messages.values()]).toEqual([
      expect.objectContaining({
        purpose: 'plan_confirmed',
        message: 'plan_confirmed',
        status: 'pending',
        variables: { total: '750 000 FCFA', installments: '6', first_due_on: '30 novembre 2026' },
      }),
    ]);
    // Un protocole d'un autre modèle, ou inconnu, est ignoré.
    expect(
      await world.useCases.recordPlanSignature.execute({
        eventId: nextEventId(),
        documentId: '0192f1c4-0000-7000-a000-00000000ffff',
        template: 'recovery_settlement_agreement',
        producerService: 'recovery',
        subjectType: 'recovery_case',
        subjectId: caseId,
        signedAt: NOW.toISOString(),
      }),
    ).toBe('ignored');
  });

  it('hors barème : chargé puis superviseur, puis le créancier en 3 jours ; accordé, le protocole part', async () => {
    const plan = await debtorProposes(OFF_SCALE);
    expect(plan).toMatchObject({
      status: 'proposed',
      withinScale: false,
      violations: ['first_payment'],
      documentId: null,
    });
    const queue = await asSupervisor(world, () => world.useCases.getMyWorkQueue.execute({ day: '' }));
    expect(queue.map((item) => item.kind)).toEqual(['plan_to_validate']);
    expect(
      (
        await rejection(
          asAgent(world, () =>
            world.useCases.approvePaymentPlan.execute({ planId: plan.id, decision: 'approve', note: '' }),
          ),
        )
      ).code,
    ).toBe('AUTH_FORBIDDEN');

    const approved = await asSupervisor(world, () =>
      world.useCases.approvePaymentPlan.execute({
        planId: plan.id,
        decision: 'approve',
        note: 'Situation vérifiée',
      }),
    );
    expect(approved).toMatchObject({ status: 'pending_creditor', documentId: null });
    const [requested] = eventsOf(world, 'recovery.decision.requested');
    expect(requested!.payload).toMatchObject({
      kind: 'plan_off_scale',
      expiresAt: '2026-11-23T09:00:00.000Z',
    });

    const decisions = await asCreditor(() =>
      world.useCases.listMyDecisions.execute({ statuses: [], caseId: '' }),
    );
    expect(decisions.items).toHaveLength(1);
    expect(decisions.items[0]).toMatchObject({ caseNumber: 'RC-000001', plan: { id: plan.id } });
    const decisionId = decisions.items[0]!.decision.id;

    const answered = await asCreditor(() =>
      world.useCases.answerDecision.execute({
        decisionId,
        idempotencyKey: 'answer-0001',
        answer: 'approve',
        comment: '',
        fileIds: [],
      }),
    );
    expect(answered.decision.decision.status).toBe('approved');
    expect(world.store.planRows.get(plan.id)).toMatchObject({
      status: 'pending_creditor',
      signatureRound: 1,
    });
    expect(world.store.planRows.get(plan.id)!.documentId).not.toBeNull();
    expect(
      (
        await asCreditor(() =>
          world.useCases.answerDecision.execute({
            decisionId,
            idempotencyKey: 'answer-0001',
            answer: 'approve',
            comment: '',
            fileIds: [],
          }),
        )
      ).decision.decision.status,
    ).toBe('approved');
    expect(
      await rejection(
        asCreditor(() =>
          world.useCases.answerDecision.execute({
            decisionId,
            idempotencyKey: 'answer-0002',
            answer: 'reject',
            comment: '',
            fileIds: [],
          }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_DECISION_CLOSED', details: { status: 'approved' } });
    expect(await sign(world.store.planRows.get(plan.id)!)).toBe('recorded');
    expect(world.store.planRows.get(plan.id)!.status).toBe('signed');
  });

  it('refusé par le créancier, l’échéancier est clos ; un créancier sans échéancier refuse la proposition', async () => {
    const plan = await debtorProposes(OFF_SCALE);
    await asSupervisor(world, () =>
      world.useCases.approvePaymentPlan.execute({ planId: plan.id, decision: 'approve', note: '' }),
    );
    const decision = [...world.store.decisionRows.values()][0]!;
    await asCreditor(() =>
      world.useCases.answerDecision.execute({
        decisionId: decision.id,
        idempotencyKey: 'answer-0001',
        answer: 'reject',
        comment: 'Non',
        fileIds: [],
      }),
    );
    expect(world.store.planRows.get(plan.id)!.status).toBe('rejected');

    const strict = await activeCase(world, 'case-key-0002', {
      claims: [{ reference: 'F-99', amount: 200_000, dueDate: '2026-10-01', description: '' }],
      evidenceFileIds: [FILE_2],
      planScale: {
        acceptsPaymentPlan: false,
        maxDurationMonths: 12,
        minFirstPaymentBps: 1_000,
        firstPaymentWithinDays: 15,
        minInstallment: 25_000,
        maxDiscountBps: 0,
      },
    });
    const refused = await rejection(
      world.useCases.proposeDebtorPaymentPlan.execute({
        caseId: strict.id,
        debtorId: strict.debtors[0]!.id,
        idempotencyKey: 'plan-key-0009',
        terms: { ...IN_SCALE, firstAmount: 20_000 },
        message: '',
      }),
    );
    expect(refused.code).toBe('RECOVERY_PLAN_OUT_OF_SCALE');
  });

  it('une seule renégociation : l’échéancier signé est remplacé, une troisième est refusée', async () => {
    const first = await debtorProposes();
    await sign(first);
    const second = await asAgent(world, () =>
      world.useCases.proposePaymentPlan.execute({
        caseId,
        idempotencyKey: 'plan-agent-0001',
        terms: IN_SCALE,
        note: '',
      }),
    );
    expect(second).toMatchObject({ renegotiatedFromId: first.id, proposedBy: { type: 'agent' } });
    await sign(second);
    expect(world.store.planRows.get(first.id)!.status).toBe('cancelled');
    expect(eventsOf(world, 'recovery.plan.signed').at(-1)!.payload).toMatchObject({ renegotiation: true });
    const third = await rejection(
      asAgent(world, () =>
        world.useCases.proposePaymentPlan.execute({
          caseId,
          idempotencyKey: 'plan-agent-0002',
          terms: IN_SCALE,
          note: '',
        }),
      ),
    );
    expect(third.code).toBe('RECOVERY_PLAN_RENEGOTIATION_EXHAUSTED');
  });

  it('nouveau lien de signature : pas avant 2 minutes, l’ancien protocole annulé', async () => {
    const plan = await debtorProposes();
    expect(
      await rejection(
        world.useCases.resendDebtorPlanSignature.execute({ caseId, debtorId, planId: plan.id }),
      ),
    ).toMatchObject({ code: 'RECOVERY_DEBTOR_CODE_TOO_SOON', details: { retryAfterSeconds: 120 } });
    at(world, '2026-11-20T09:03:00.000Z');
    const resent = await world.useCases.resendDebtorPlanSignature.execute({
      caseId,
      debtorId,
      planId: plan.id,
    });
    expect(resent.signatureExpiresAt).toEqual(new Date('2026-11-27T09:03:00.000Z'));
    expect(world.cancellations.cancelled).toEqual([
      { documentId: plan.documentId, reason: 'Nouveau lien de signature demandé par le débiteur' },
    ]);
    const current = world.store.planRows.get(plan.id)!;
    expect(current).toMatchObject({ signatureRound: 2 });
    expect(current.documentId).not.toBe(plan.documentId);
    // L'ancien protocole, annulé, n'est plus reconnu.
    expect(await sign(plan)).toBe('ignored');
    expect(await sign(current)).toBe('recorded');
  });

  it('sans téléphone du débiteur, pas de signature en ligne', async () => {
    const record = await activeCase(world, 'case-key-0003', {
      claims: [{ reference: 'F-77', amount: 900_000, dueDate: '2026-10-01', description: '' }],
      evidenceFileIds: [FILE_3],
      debtors: [{ ...caseInput().debtors[0]!, phones: [], emails: ['achats@exemple.bj'] }],
    });
    const refused = await rejection(
      world.useCases.proposeDebtorPaymentPlan.execute({
        caseId: record.id,
        debtorId: record.debtors[0]!.id,
        idempotencyKey: 'plan-key-0003',
        terms: { ...IN_SCALE, firstAmount: 90_000 },
        message: '',
      }),
    );
    expect(refused).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
  });
});
