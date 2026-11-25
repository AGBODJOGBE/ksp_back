import { Metadata } from '@grpc/grpc-js';
import { DebtorLinks } from '../../application/debtor-access/debtor-links.service';
import {
  activeCase,
  type AmicableWorld,
  amicableWorld,
  asAgent,
  asSupervisor,
} from '../../application/testing/amicable-scenarios';
import { asCreditor, asService, rejection } from '../../application/testing/fakes';
import { DEBTOR_SESSION_METADATA } from './debtor-session';
import {
  RecoveryAdminGrpcController,
  RecoveryCreditorGrpcController,
  RecoveryDebtorGrpcController,
} from './recovery.controller';

const xof = (amount: number) => ({ amount, currency: 'XOF' });
const TERMS = {
  firstAmount: xof(30_000),
  firstDueDate: '2026-11-30',
  rhythm: 'monthly',
  installmentsCount: 5,
};

describe('procédure amiable : adaptateurs gRPC (lot R4)', () => {
  let world: AmicableWorld;
  let admin: RecoveryAdminGrpcController;
  let caseId: string;

  beforeEach(async () => {
    world = amicableWorld();
    admin = new RecoveryAdminGrpcController(world.useCases);
    caseId = (await activeCase(world)).id;
  });

  it('promesse, échéancier, « Ma journée » et décision : montants en XOF, dates ISO 8601', async () => {
    const promise = await asAgent(world, () =>
      admin.recordPromise({
        caseId,
        idempotencyKey: 'promise-grpc-1',
        amount: xof(40_000),
        dueDate: '2026-11-27',
        note: '',
      }),
    );
    expect(promise.promise).toMatchObject({
      amount: xof(40_000),
      dueDate: '2026-11-27',
      status: 'pending',
      recordedBy: { type: 'staff' },
      createdAt: '2026-11-20T09:00:00.000Z',
    });
    expect(
      await rejection(
        asAgent(world, () =>
          admin.recordPromise({
            caseId,
            idempotencyKey: 'promise-grpc-2',
            amount: { amount: 1, currency: 'EUR' },
            dueDate: '2026-11-27',
            note: '',
          }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'amount' } });

    const { plan } = await asAgent(world, () =>
      admin.proposePaymentPlan({ caseId, idempotencyKey: 'plan-grpc-1', terms: TERMS, note: '' }),
    );
    expect(plan).toMatchObject({
      status: 'proposed',
      total: xof(750_000),
      withinScale: false,
      violations: ['first_payment'],
      proposedBy: 'agent',
      renegotiation: false,
      documentId: '',
      signedAt: '',
      missedCount: 0,
    });
    expect(plan!.installments[0]).toMatchObject({
      rank: 1,
      amount: xof(30_000),
      paidAmount: xof(0),
      status: 'upcoming',
      paidAt: '',
    });

    const day = await asSupervisor(world, () => admin.getMyWorkQueue({ day: '2026-11-20' }));
    expect(day.items).toEqual([
      expect.objectContaining({
        kind: 'plan_to_validate',
        case: expect.objectContaining({ id: caseId, number: 'RC-000001' }),
      }),
    ]);
    await asSupervisor(world, () =>
      admin.approvePaymentPlan({ planId: plan!.id, decision: 'approve', note: '' }),
    );
    const creditor = new RecoveryCreditorGrpcController(world.useCases);
    const decisions = await asCreditor(() => creditor.listMyDecisions({ statuses: [], caseId: '' }));
    expect(decisions).toEqual({
      decisions: [
        expect.objectContaining({
          caseNumber: 'RC-000001',
          kind: 'plan_off_scale',
          status: 'pending',
          expiresAt: '2026-11-23T09:00:00.000Z',
          answeredAt: '',
          paymentPlan: expect.objectContaining({ id: plan!.id, status: 'pending_creditor' }),
          settlement: undefined,
        }),
      ],
      nextCursor: '',
    });
    const answered = await asCreditor(() =>
      creditor.answerDecision({
        decisionId: decisions.decisions[0]!.id,
        idempotencyKey: 'answer-grpc-1',
        answer: 'reject',
        comment: '',
        fileIds: [],
      }),
    );
    expect(answered.decision).toMatchObject({ status: 'rejected', answeredAt: '2026-11-20T09:00:00.000Z' });
    expect(answered.case).toMatchObject({ id: caseId, stage: 'notice' });
  });

  it('contact et note : une entrée du journal ; débiteur : simulation par sa session', async () => {
    const contact = await asAgent(world, () =>
      admin.recordContact({
        caseId,
        idempotencyKey: 'contact-grpc-1',
        debtorId: '',
        channel: 'visit',
        direction: 'outbound',
        outcome: 'reached',
        note: '',
        occurredAt: '',
        callbackAt: '',
        fileId: '',
      }),
    );
    expect(contact.entry).toMatchObject({
      kind: 'contact',
      channel: 'visit',
      author: { type: 'staff' },
      occurredAt: '2026-11-20T09:00:00.000Z',
    });
    const note = await asAgent(world, () => admin.addInternalNote({ caseId, text: 'À rappeler lundi' }));
    expect(note.entry).toMatchObject({ kind: 'note', internal: true, summary: 'À rappeler lundi' });

    const debtorId = world.deps.cases.cases.get(caseId)!.debtors[0]!.id;
    const debtor = new RecoveryDebtorGrpcController(world.useCases);
    const { token } = await new DebtorLinks(world.deps).issue({ caseId, debtorId });
    const gateway = <T>(fn: () => Promise<T>) => asService('gateway', fn);
    await gateway(() => debtor.sendDebtorAccessCode({ token }));
    const { sessionToken } = await gateway(() =>
      debtor.verifyDebtorAccessCode({ token, code: world.notifier.lastCode() }),
    );
    const metadata = new Metadata();
    metadata.set(DEBTOR_SESSION_METADATA, sessionToken);
    const simulation = await gateway(() =>
      debtor.simulateDebtorPaymentPlan({ terms: { ...TERMS, firstAmount: xof(75_000) } }, metadata),
    );
    expect(simulation).toMatchObject({ total: xof(750_000), withinScale: true, violations: [] });
    expect(simulation.installments).toHaveLength(6);
  });
});
