import { Metadata } from '@grpc/grpc-js';
import { DEBTOR_CONTACT_CONTEXT } from '../../application/debtor-access/debtor-contact';
import { DebtorLinks } from '../../application/debtor-access/debtor-links.service';
import {
  activeCase as activeAmicableCase,
  amicableWorld,
  asAgent,
  asSupervisor,
} from '../../application/testing/amicable-scenarios';
import { FILE_2 } from '../../application/testing/case-scenarios';
import { CapturingNotifier } from '../../application/testing/debtor-access.fakes';
import {
  asCreditor,
  asService,
  FakePersonalData,
  makeDeps,
  NOW,
  rejection,
} from '../../application/testing/fakes';
import { activeCase, debtorScope, moneyWorld, payLink } from '../../application/testing/money-scenarios';
import { createUseCases } from '../../application/use-cases';
import { DEBTOR_SESSION_METADATA } from './debtor-session';
import {
  RecoveryAdminGrpcController,
  RecoveryCreditorGrpcController,
  RecoveryDebtorGrpcController,
} from './recovery.controller';

const xof = (amount: number) => ({ amount, currency: 'XOF' });
const IN_SCALE = { firstAmount: 75_000, firstDueDate: '2026-11-30', rhythm: 'monthly', installmentsCount: 5 };

describe('compléments du recouvrement : adaptateurs gRPC', () => {
  it('fiche du dossier : échéancier en cours, promesses, remises, réponse du créancier à la contestation', async () => {
    const world = amicableWorld();
    const admin = new RecoveryAdminGrpcController(world.useCases);
    const creditor = new RecoveryCreditorGrpcController(world.useCases);
    const record = await activeAmicableCase(world);
    const caseId = record.id;
    const debtorId = record.debtors[0]!.id;

    await asAgent(world, () =>
      admin.recordPromise({
        caseId,
        idempotencyKey: 'promise-key-0001',
        amount: xof(40_000),
        dueDate: '2026-11-27',
        note: '',
      }),
    );
    await asAgent(world, () =>
      admin.proposeSettlement({
        caseId,
        idempotencyKey: 'settle-key-0001',
        payNow: xof(700_000),
        validUntil: '2026-11-30',
        note: '',
      }),
    );
    const plan = await world.useCases.proposeDebtorPaymentPlan.execute({
      caseId,
      debtorId,
      idempotencyKey: 'plan-key-0001',
      terms: IN_SCALE,
      message: '',
    });
    await world.useCases.disputeDebtorCase.execute({
      caseId,
      debtorId,
      idempotencyKey: 'dispute-key-0001',
      reason: 'wrong_amount',
      text: 'Le montant est faux',
      fileIds: [],
    });

    const pending = await asCreditor(() =>
      creditor.listMyDecisions({ statuses: [], caseId, page: undefined }),
    );
    const asked = pending.decisions.find((decision) => decision.kind === 'dispute_response')!;
    expect(asked).toMatchObject({
      caseId,
      status: 'pending',
      dispute: { reason: 'wrong_amount', text: 'Le montant est faux', status: 'open', creditorAnswer: '' },
    });
    expect(asked.expiresAt).toBe(asked.dispute!.creditorAnswerDueAt);

    const answered = await asCreditor(() =>
      creditor.answerDecision({
        decisionId: asked.id,
        idempotencyKey: 'answer-key-0001',
        answer: 'answer',
        comment: 'Bon de livraison signé joint',
        fileIds: [FILE_2],
      }),
    );
    expect(answered.decision).toMatchObject({
      status: 'answered',
      dispute: {
        status: 'creditor_answered',
        creditorAnswer: 'Bon de livraison signé joint',
        creditorFileIds: [FILE_2],
      },
    });

    const expected = {
      status: 'suspended',
      currentPlan: { id: plan.id, status: 'proposed', total: xof(750_000) },
      promises: [{ amount: xof(40_000), dueDate: '2026-11-27', status: 'pending' }],
      settlements: [{ payNow: xof(700_000), waived: xof(50_000), status: 'pending_creditor' }],
      disputes: [{ status: 'creditor_answered', creditorAnswer: 'Bon de livraison signé joint' }],
    };
    const backOffice = await asSupervisor(world, () => admin.getCase({ caseId }));
    expect(backOffice.case).toMatchObject(expected);
    const mine = await asCreditor(() => creditor.getMyCase({ caseId }));
    expect(mine.case).toMatchObject(expected);
  });

  it('relevés du créancier : montants en XOF, PDF, facture absente, dates ISO 8601', async () => {
    const world = moneyWorld();
    const creditor = new RecoveryCreditorGrpcController(world.useCases);
    const record = await activeCase(world);
    await world.useCases.createDebtorPayment.execute({
      ...debtorScope(record),
      idempotencyKey: 'pay-key-0001',
      amount: 100_000,
      settlementId: '',
    });
    await payLink(world, record);
    world.deps.clock.current = new Date('2026-11-30T23:30:00.000Z');
    await world.useCases.issueMonthlyStatements.execute();

    const page = await asCreditor(() =>
      creditor.listMyStatements({ period: '2026-11', caseId: record.id, page: { limit: 10, cursor: '' } }),
    );
    expect(page).toEqual({
      statements: [
        {
          id: expect.any(String),
          period: '2026-11',
          caseId: record.id,
          caseNumber: record.number,
          collected: xof(100_000),
          commission: xof(10_000),
          costs: xof(0),
          remitted: xof(90_000),
          documentId: world.documents.generated.get(`recovery:statement:${record.id}:2026-11`)!.id,
          invoiceId: '',
          issuedAt: '2026-11-30T23:30:00.000Z',
        },
      ],
      nextCursor: '',
    });
  });

  it('dossier clos depuis peu : la session lit la situation et les documents, toute écriture est refusée', async () => {
    const CASE_ID = '0192f1c4-0000-7000-8000-0000000ca5e1';
    const DEBTOR_ID = '0192f1c4-0000-7000-8000-0000000deb01';
    const notifier = new CapturingNotifier();
    const deps = makeDeps({ notifier });
    const caseDebtor = {
      caseNumber: 'RC-000123',
      caseStatus: 'active' as const,
      creditor: { type: 'user' as const, id: '0192f1c4-0000-7000-8000-00000000c001' },
    };
    const contacts = [
      {
        channel: 'phone' as const,
        valueEnc: new FakePersonalData().encrypt('+2290197000145', DEBTOR_CONTACT_CONTEXT),
      },
    ];
    deps.debtorAccess.reader.add(CASE_ID, DEBTOR_ID, caseDebtor, contacts);
    const controller = new RecoveryDebtorGrpcController(createUseCases(deps));
    const { token } = await new DebtorLinks(deps).issue({ caseId: CASE_ID, debtorId: DEBTOR_ID });
    deps.debtorAccess.reader.add(
      CASE_ID,
      DEBTOR_ID,
      { ...caseDebtor, caseStatus: 'closed', closedAt: NOW },
      contacts,
    );

    const gateway = <T>(fn: () => Promise<T>) => asService('gateway', fn);
    await gateway(() => controller.sendDebtorAccessCode({ token }));
    const { sessionToken } = await gateway(() =>
      controller.verifyDebtorAccessCode({ token, code: notifier.lastCode() }),
    );
    const metadata = new Metadata();
    metadata.set(DEBTOR_SESSION_METADATA, sessionToken);
    const call = (method: keyof RecoveryDebtorGrpcController) =>
      gateway(() =>
        (controller[method] as (request: never, metadata?: Metadata) => Promise<unknown>).call(
          controller,
          {} as never,
          metadata,
        ),
      );

    for (const method of [
      'createDebtorPayment',
      'simulateDebtorPaymentPlan',
      'proposeDebtorPaymentPlan',
      'resendDebtorPlanSignature',
      'disputeDebtorCase',
      'createDebtorUpload',
      'completeDebtorUpload',
      'requestDebtorCallback',
    ] as const) {
      expect(await rejection(call(method))).toMatchObject({
        code: 'RECOVERY_INVALID_TRANSITION',
        details: { status: 'closed' },
      });
    }
    // Lecture : la session passe (le dossier n'est pas dans le dépôt de ce test).
    for (const method of ['getDebtorCase', 'getDebtorDocumentUrl'] as const) {
      const error = await rejection(call(method));
      expect(error.code).not.toBe('RECOVERY_DEBTOR_SESSION_INVALID');
      expect(error.code).not.toBe('RECOVERY_INVALID_TRANSITION');
    }
    await expect(gateway(() => controller.endDebtorSession({}, metadata))).resolves.toEqual({
      endedAt: NOW.toISOString(),
    });
  });
});
