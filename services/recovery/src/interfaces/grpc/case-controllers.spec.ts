import { type recoveryV1 } from '@ksp/contracts';
import {
  caseWorld,
  type CaseWorld,
  FILE_1,
  signMandate,
  SUPERVISOR_ID,
} from '../../application/testing/case-scenarios';
import { asCreditor, asStaff, CREDITOR_ID, NOW, rejection } from '../../application/testing/fakes';
import { RecoveryAdminGrpcController, RecoveryCreditorGrpcController } from './recovery.controller';

const xof = (amount: number) => ({ amount, currency: 'XOF' });

const input: recoveryV1.CaseInput = {
  kind: 'b2c',
  nature: 'loan',
  debtors: [
    {
      kind: 'person',
      role: 'main',
      firstNames: 'Koffi',
      lastName: 'Dossou',
      legalName: '',
      ifu: '',
      rccm: '',
      representativeName: '',
      phones: ['+22996000301'],
      emails: [],
      address: 'Cadjèhoun, Cotonou',
      communeKey: '',
    },
  ],
  claims: [
    { reference: 'PRET-1', amount: xof(200_000), dueDate: '2026-08-31', description: 'Prêt personnel' },
  ],
  interests: xof(10_000),
  alreadyPaid: undefined,
  priorEffort: {
    remindersCount: 1,
    lastReminderDate: '',
    channels: ['phone'],
    debtAcknowledged: true,
    acknowledgmentFileId: '',
    promisesReceived: '',
    preserveRelationship: false,
  },
  planScale: undefined,
  evidenceFileIds: [FILE_1],
};

describe('contrôleurs gRPC des dossiers (traductions du contrat)', () => {
  let world: CaseWorld;
  let creditor: RecoveryCreditorGrpcController;
  let admin: RecoveryAdminGrpcController;

  beforeEach(() => {
    world = caseWorld();
    creditor = new RecoveryCreditorGrpcController(world.useCases);
    admin = new RecoveryAdminGrpcController(world.useCases);
  });

  it('CreateCase rend le dossier au format du contrat (montants en XOF, dates ISO, -1 = absent)', async () => {
    const response = await asCreditor(() =>
      creditor.createCase({ idempotencyKey: 'case-key-ctrl-1', input }),
    );
    expect(response.created).toBe(true);
    expect(response.possibleDuplicates).toEqual([]);
    expect(response.case).toMatchObject({
      number: 'RC-000001',
      kind: 'b2c',
      nature: 'loan',
      status: 'draft',
      stage: '',
      score: -1,
      creditor: { type: 'user', id: CREDITOR_ID },
      amounts: { principal: xof(200_000), interests: xof(10_000), due: xof(210_000), waived: xof(0) },
      priorEffort: { remindersCount: 1, debtAcknowledged: true, lastReminderDate: '' },
      planScale: { maxDurationMonths: 6, minInstallment: xof(5_000) },
      nextDeadline: { kind: 'fee_payment', dueAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString() },
      source: 'form',
      createdAt: NOW.toISOString(),
      submittedAt: '',
    });
    expect(response.case!.debtors[0]).toMatchObject({
      displayName: 'Koffi Dossou',
      phones: ['+2290196000301'],
      address: 'Cadjèhoun, Cotonou',
    });
    expect(response.case!.documents[0]).toMatchObject({
      kind: 'evidence',
      fileId: FILE_1,
      documentId: '',
      addedBy: { type: 'creditor', userId: CREDITOR_ID },
    });
    expect(response.case!.mandate).toBeUndefined();
    expect(response.case!.fee).toBeUndefined();
  });

  it('montant hors XOF refusé ; liste, journal et fiche du back-office', async () => {
    const wrong = await rejection(
      asCreditor(() =>
        creditor.createCase({
          idempotencyKey: 'case-key-ctrl-2',
          input: { ...input, interests: { amount: 10, currency: 'EUR' } },
        }),
      ),
    );
    expect(wrong).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'interests' } });
    const created = await asCreditor(() => creditor.createCase({ idempotencyKey: 'case-key-ctrl-1', input }));
    const caseId = created.case!.id;
    await signMandate(world, caseId);
    world.wallet.balances.set(CREDITOR_ID, 50_000);
    const paid = await asCreditor(() => creditor.payCaseFee({ caseId, idempotencyKey: 'pay-key-ctrl-1' }));
    expect(paid.case).toMatchObject({
      status: 'under_review',
      fee: { amount: xof(10_000), status: 'paid', refundedAmount: xof(0) },
      mandate: { status: 'signed', signedAt: NOW.toISOString() },
      pricing: { feeRuleVersion: 1 },
    });
    const list = await asCreditor(() => creditor.listMyCases({ filter: undefined, page: undefined }));
    expect(list).toMatchObject({
      total: 1,
      nextCursor: '',
      cases: [{ debtorName: 'Koffi Dossou', due: xof(210_000) }],
    });

    const asSupervisor = <T>(fn: () => Promise<T>) => asStaff(SUPERVISOR_ID, ['recovery_supervisor'], fn);
    const sheet = await asSupervisor(() => admin.getCase({ caseId }));
    expect(sheet.injunctionEligible).toBe(true);
    expect(sheet.scoreFactors.map((factor) => factor.criterion)).toEqual([
      'debtAge',
      'writtenAcknowledgment',
      'evidenceQuality',
      'amount',
      'validContacts',
      'partialPayments',
    ]);
    expect(sheet.scoreFactors[1]).toEqual({ criterion: 'writtenAcknowledgment', value: 'oui', points: 100 });
    const accepted = await asSupervisor(() =>
      admin.assessCase({
        caseId,
        idempotencyKey: 'assess-ctrl-1',
        decision: 'accept',
        note: '',
        agentUserId: '',
        rejectionReason: '',
      }),
    );
    expect(accepted.case).toMatchObject({
      status: 'active',
      stage: 'notice',
      stageHistory: [{ fromStage: '', toStage: 'notice' }],
    });
    const journal = await asSupervisor(() =>
      admin.listCaseJournal({ caseId, includeInternal: true, page: undefined }),
    );
    expect(journal.entries[0]).toMatchObject({
      kind: 'status_changed',
      author: { type: 'staff', userId: SUPERVISOR_ID },
    });
    expect(journal.entries.find((entry) => entry.kind === 'payment')).toMatchObject({ amount: xof(10_000) });
    const overview = await asSupervisor(() => admin.getRecoveryOverview({ communeKey: '' }));
    expect(overview).toMatchObject({
      casesByStage: [{ stage: 'notice', count: 1 }],
      entrusted: xof(210_000),
    });
  });

  it('préférences du créancier au format du contrat', async () => {
    const preferences = await asCreditor(() => creditor.getMyPreferences());
    expect(preferences.preferences).toMatchObject({ b2bScale: { maxDurationMonths: 12 }, notifyUserIds: [] });
    const missing = await rejection(
      asCreditor(() => creditor.updateMyPreferences({ preferences: undefined })),
    );
    expect(missing.code).toBe('RECOVERY_VALIDATION_FAILED');
  });
});
