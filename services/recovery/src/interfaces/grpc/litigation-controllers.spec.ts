import { asCreditor, rejection } from '../../application/testing/fakes';
import {
  ACT_FILE,
  asLegal,
  asPartner,
  BAILIFF_USER_ID,
  caseWithBailiff,
  litigationWorld,
  partnerInput,
} from '../../application/testing/litigation-scenarios';
import {
  RecoveryAdminGrpcController,
  RecoveryCreditorGrpcController,
  RecoveryPartnerGrpcController,
} from './recovery.controller';

const xof = (amount: number) => ({ amount, currency: 'XOF' });

describe('contentieux : adaptateurs gRPC (lot R5)', () => {
  it('partenaire du référentiel : chiffres absents à -1, honoraires en XOF', async () => {
    const world = litigationWorld();
    const admin = new RecoveryAdminGrpcController(world.useCases);
    const input = partnerInput();
    const created = await asLegal(world, () =>
      admin.createPartner({
        idempotencyKey: 'partner-grpc-1',
        input: {
          ...input,
          communeKeys: [...input.communeKeys],
          phones: [...input.phones],
          fees: [{ actType: 'summons_to_pay', amount: xof(35_000) }],
        },
      }),
    );
    expect(created.partner).toMatchObject({
      kind: 'bailiff',
      status: 'pending_verification',
      communeKeys: ['cotonou'],
      fees: [{ actType: 'summons_to_pay', amount: xof(35_000) }],
      averageDelayDays: -1,
      successRateBps: -1,
      openAssignments: 0,
      verifiedBy: undefined,
      verifiedAt: '',
    });
  });

  it('dossier de l’huissier : assignation, pièces visibles seules, actes ; hors périmètre : 404', async () => {
    const world = litigationWorld();
    const { record, assignment, escalation } = await caseWithBailiff(world);
    const admin = new RecoveryAdminGrpcController(world.useCases);
    const partner = new RecoveryPartnerGrpcController(world.useCases);
    const creditor = new RecoveryCreditorGrpcController(world.useCases);

    const decisions = await asCreditor(() =>
      creditor.listMyDecisions({ statuses: ['approved'], caseId: record.id }),
    );
    expect(decisions.decisions[0]?.feeQuote).toMatchObject({
      id: escalation.quote.quote.id,
      stage: 'bailiff',
      total: xof(60_000),
      provision: xof(60_000),
      partner: { name: 'Me Adjovi', kind: 'bailiff' },
      lines: [
        { label: 'Sommation de payer', amount: xof(35_000) },
        { label: 'Frais de déplacement', amount: xof(25_000) },
      ],
    });

    const listed = await asPartner(BAILIFF_USER_ID, () => partner.listMyAssignments({ statuses: [] }));
    expect(listed.assignments).toEqual([
      expect.objectContaining({ id: assignment.assignment.id, caseNumber: record.number, status: 'active' }),
    ]);
    const file = await asPartner(BAILIFF_USER_ID, () =>
      partner.getMyAssignment({ assignmentId: assignment.assignment.id }),
    );
    expect(file.file?.debtors[0]).toMatchObject({
      legalName: 'SARL Bénin Négoce',
      phones: ['+2290197000101'],
    });
    expect(file.file?.amounts?.due).toEqual(xof(750_000));
    expect(file.file?.documents.map((document) => document.kind)).not.toContain('fee_quote');
    expect(file.file?.notices[0]).toMatchObject({ status: 'delivered', deliveryMethod: 'registered_mail' });
    expect(file.file?.creditor).toMatchObject({ type: 'user', displayName: 'Awa Dossou' });

    const act = await asPartner(BAILIFF_USER_ID, () =>
      partner.recordLegalAct({
        assignmentId: assignment.assignment.id,
        idempotencyKey: 'act-grpc-0001',
        type: 'summons_to_pay',
        actDate: '2026-12-07',
        cost: xof(35_000),
        fileId: ACT_FILE,
        note: '',
        nextStepDate: '',
      }),
    );
    expect(act.act).toMatchObject({
      type: 'summons_to_pay',
      cost: xof(35_000),
      nextStepDate: '',
      fileId: ACT_FILE,
    });
    const card = await asLegal(world, () =>
      admin.exportCaseJournal({ caseId: record.id, idempotencyKey: 'export-grpc-1' }),
    );
    expect(card.documentId).not.toBe('');

    expect(
      await rejection(
        asPartner('0192f1c4-0000-7000-8000-0000000b0000', () =>
          partner.getMyAssignment({ assignmentId: assignment.assignment.id }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_ASSIGNMENT_NOT_FOUND' });

    const stopped = await asCreditor(() => creditor.stopCase({ caseId: record.id, reason: 'Accord direct' }));
    expect(stopped.case).toMatchObject({ status: 'closed', closure: { reason: 'abandoned_by_creditor' } });
  });
});
