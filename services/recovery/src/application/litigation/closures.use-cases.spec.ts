import { activeCase, asAgent, asSupervisor, eventsOf } from '../testing/amicable-scenarios';
import { asOtherCreditor } from '../testing/case-scenarios';
import { asCreditor, rejection } from '../testing/fakes';
import {
  asPartner,
  at,
  BAILIFF_USER_ID,
  caseOf,
  caseWithBailiff,
  litigationWorld,
  type LitigationWorld,
  PROOF_FILE,
} from '../testing/litigation-scenarios';

const declareDirect = (
  world: LitigationWorld,
  caseId: string,
  key: string,
  receivedOn: string,
  amount = 100_000,
) =>
  asCreditor(() =>
    world.useCases.declareDirectPayment.execute({
      caseId,
      idempotencyKey: key,
      amount,
      receivedOn,
      note: '',
      proofFileId: '',
    }),
  );

describe('arrêt du dossier par le créancier (StopCase, R-PR-06)', () => {
  it('clôt « abandon par le créancier » ; un paiement direct reste commissionné 30 jours', async () => {
    const world = litigationWorld();
    const record = await activeCase(world);
    expect(
      await rejection(asCreditor(() => world.useCases.stopCase.execute({ caseId: record.id, reason: 'x' }))),
    ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'reason' } });
    expect(
      await rejection(
        asOtherCreditor(() =>
          world.useCases.stopCase.execute({ caseId: record.id, reason: 'Accord direct' }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_CASE_NOT_FOUND' });
    const stopped = await asCreditor(() =>
      world.useCases.stopCase.execute({ caseId: record.id, reason: 'Accord trouvé avec le débiteur' }),
    );
    expect(stopped.view.record).toMatchObject({ status: 'closed', closureReason: 'abandoned_by_creditor' });
    expect(stopped.closure).toMatchObject({
      closedBy: { type: 'creditor' },
      note: 'Accord trouvé avec le débiteur',
    });
    expect(eventsOf(world, 'recovery.case.closed').at(-1)?.payload).toMatchObject({
      reason: 'abandoned_by_creditor',
      settlementCertificateDocumentId: null,
    });
    expect(world.deps.cases.evidence.find((e) => e.action === 'case.stopped')?.summary).toContain(
      'jusqu’au 20 décembre 2026',
    );
    // Rejoué : le dossier tel quel.
    const again = await asCreditor(() =>
      world.useCases.stopCase.execute({ caseId: record.id, reason: 'Accord trouvé avec le débiteur' }),
    );
    expect(again.view.record.status).toBe('closed');

    at(world, '2026-12-10T09:00:00.000Z');
    const within = await declareDirect(world, record.id, 'direct-0001', '2026-12-05');
    expect(within.collection).toMatchObject({ settlement: 'invoiced', commission: 10_000 });
    at(world, '2027-01-05T09:00:00.000Z');
    const after = await declareDirect(world, record.id, 'direct-0002', '2027-01-02');
    expect(after.collection).toMatchObject({ settlement: 'invoiced', commission: 0 });
    expect(caseOf(world, record.id).paid).toBe(200_000);
  });

  it('termine la mission du partenaire et signale le reste de la provision à rendre', async () => {
    const world = litigationWorld();
    const { record, assignment } = await caseWithBailiff(world);
    await asCreditor(() =>
      world.useCases.stopCase.execute({ caseId: record.id, reason: 'Le débiteur a disparu' }),
    );
    expect(world.litigation.assignmentRows.get(assignment.assignment.id)).toMatchObject({
      status: 'completed',
    });
    expect(world.deps.cases.evidence.find((e) => e.action === 'provision.remainder')).toMatchObject({
      amount: 60_000,
      internal: false,
    });
    expect(
      await rejection(
        asPartner(BAILIFF_USER_ID, () =>
          world.useCases.getMyAssignment.execute({ assignmentId: assignment.assignment.id }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_ASSIGNMENT_NOT_FOUND' });
  });
});

describe('clôture au back-office (CloseCase, R-PR-10)', () => {
  it('ne clôt que pour un motif du back-office, à ses conditions', async () => {
    const world = litigationWorld();
    const record = await activeCase(world);
    const close = (reason: string, proofFileId = '') =>
      asSupervisor(world, () =>
        world.useCases.closeCase.execute({
          caseId: record.id,
          reason,
          note: 'Constat de l’huissier',
          proofFileId,
        }),
      );
    expect(await rejection(close('paid'))).toMatchObject({ details: { field: 'reason' } });
    expect(await rejection(close('prescribed'))).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
    expect(await rejection(close('unrecoverable'))).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
    expect(
      await rejection(
        asAgent(world, () =>
          world.useCases.closeCase.execute({
            caseId: record.id,
            reason: 'unrecoverable',
            note: '',
            proofFileId: '',
          }),
        ),
      ),
    ).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    const closed = await close('unrecoverable', PROOF_FILE);
    expect(closed.view.record).toMatchObject({ status: 'closed', closureReason: 'unrecoverable' });
    expect(closed.closure).toMatchObject({ note: 'Constat de l’huissier', closedBy: { type: 'agent' } });
    expect(caseOf(world, record.id).documents.find((d) => d.fileId === PROOF_FILE)).toMatchObject({
      kind: 'evidence',
      visibleToPartner: false,
    });
    expect(world.deps.cases.audit.find((entry) => entry.action === 'case.closed')).toMatchObject({
      details: { reason: 'unrecoverable' },
    });
    expect((await close('unrecoverable', PROOF_FILE)).view.record.status).toBe('closed');
    expect(await rejection(close('prescribed'))).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
  });

  it('« irrecouvrable » sans pièce après six mois sans contact possible', async () => {
    const world = litigationWorld();
    const record = await activeCase(world);
    at(world, '2027-05-21T09:00:00.000Z');
    const closed = await asSupervisor(world, () =>
      world.useCases.closeCase.execute({
        caseId: record.id,
        reason: 'unrecoverable',
        note: '',
        proofFileId: '',
      }),
    );
    expect(closed.view.record.closureReason).toBe('unrecoverable');
  });

  it('termine la mission du partenaire quand le dossier est soldé ailleurs (tâche du contentieux)', async () => {
    const world = litigationWorld();
    const { record, assignment } = await caseWithBailiff(world);
    await declareDirect(world, record.id, 'direct-0001', '2026-12-07', 750_000);
    expect(caseOf(world, record.id)).toMatchObject({ status: 'closed', closureReason: 'paid' });
    expect((await world.useCases.watchLitigation.execute()).missionsCompleted).toBe(1);
    expect(world.litigation.assignmentRows.get(assignment.assignment.id)?.status).toBe('completed');
    expect((await world.useCases.watchLitigation.execute()).missionsCompleted).toBe(0);
  });
});
