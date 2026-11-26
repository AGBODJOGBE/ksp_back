import { asAgent, asStaffNow, eventsOf } from '../testing/amicable-scenarios';
import { rejection } from '../testing/fakes';
import {
  ACT_FILE,
  activePartner,
  asLegal,
  asPartner,
  at,
  BAILIFF_USER_ID,
  caseAtFormalNotice,
  caseOf,
  caseWithBailiff,
  litigationWorld,
  type LitigationWorld,
  OTHER_BAILIFF_USER_ID,
  VERIFICATION_FILE_2,
} from '../testing/litigation-scenarios';

const FINANCE_ID = '0192f1c4-0000-7000-8000-00000000f0a1';

function recordAct(
  world: LitigationWorld,
  assignmentId: string,
  change: Record<string, unknown> = {},
  user = BAILIFF_USER_ID,
) {
  return asPartner(user, () =>
    world.useCases.recordLegalAct.execute({
      assignmentId,
      idempotencyKey: 'act-key-0001',
      type: 'summons_to_pay',
      actDate: '2026-12-07',
      cost: 35_000,
      fileId: ACT_FILE,
      note: '',
      nextStepDate: '2026-12-21',
      ...change,
    }),
  );
}

describe('assignation des partenaires (UC-RC-20, R-HU-02, R-HU-07)', () => {
  it("n'assigne qu'à une étape payante ouverte, avec la provision du créancier", async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    expect(
      await rejection(
        asLegal(world, () =>
          world.useCases.assignPartner.execute({
            caseId: record.id,
            partnerId: partner.partner.id,
            note: '',
          }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_CREDITOR_APPROVAL_REQUIRED' });
  });

  it('assigne : pièces de la mission visibles du partenaire, partenaire et créancier prévenus', async () => {
    const world = litigationWorld();
    const { record, partner, assignment } = await caseWithBailiff(world);
    expect(assignment.assignment).toMatchObject({ status: 'active', partnerId: partner.partner.id });
    expect(assignment.partner).toMatchObject({ name: 'Me Adjovi' });
    expect(assignment.assignment.quoteDocumentId).not.toBeNull();
    const visible = Object.fromEntries(record.documents.map((d) => [d.kind, d.visibleToPartner]));
    expect(visible).toMatchObject({
      evidence: true,
      mandate: true,
      formal_notice: true,
      notice_delivery_proof: true,
      fee_quote: false,
    });
    expect(eventsOf(world, 'recovery.partner.assigned').at(-1)?.payload).toEqual({
      caseId: record.id,
      caseNumber: record.number,
      creditor: record.creditor,
      assignmentId: assignment.assignment.id,
      partnerId: partner.partner.id,
      partnerKind: 'bailiff',
      partnerUserId: BAILIFF_USER_ID,
      assignedAt: '2026-12-07T09:00:00.000Z',
    });
    // Même partenaire : rendu tel quel ; un autre : retrait d'abord.
    const again = await asLegal(world, () =>
      world.useCases.assignPartner.execute({ caseId: record.id, partnerId: partner.partner.id, note: '' }),
    );
    expect(again.assignment.id).toBe(assignment.assignment.id);
    const other = await activePartner(world, 'partner-0002', {
      name: 'Me Autre',
      userId: OTHER_BAILIFF_USER_ID,
      verificationFileId: VERIFICATION_FILE_2,
    });
    expect(
      await rejection(
        asLegal(world, () =>
          world.useCases.assignPartner.execute({ caseId: record.id, partnerId: other.partner.id, note: '' }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });

    // Retrait motivé : l'ancien partenaire perd l'accès, l'historique reste ; un autre est assigné.
    const withdrawn = await asLegal(world, () =>
      world.useCases.withdrawPartner.execute({
        caseId: record.id,
        assignmentId: assignment.assignment.id,
        reason: 'Sans nouvelles depuis un mois',
      }),
    );
    expect(withdrawn.assignment).toMatchObject({
      status: 'withdrawn',
      withdrawReason: 'Sans nouvelles depuis un mois',
    });
    expect(
      await rejection(
        asPartner(BAILIFF_USER_ID, () =>
          world.useCases.getMyAssignment.execute({ assignmentId: assignment.assignment.id }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_ASSIGNMENT_NOT_FOUND' });
    const history = await asPartner(BAILIFF_USER_ID, () =>
      world.useCases.listMyAssignments.execute({ statuses: ['withdrawn'] }),
    );
    expect(history.items.map((item) => item.assignment.id)).toEqual([assignment.assignment.id]);
    const next = await asLegal(world, () =>
      world.useCases.assignPartner.execute({
        caseId: record.id,
        partnerId: other.partner.id,
        note: 'Relais',
      }),
    );
    expect(next.assignment).toMatchObject({ status: 'active', note: 'Relais' });
  });
});

describe('accès du partenaire (UC-RC-21, R-AR-02, R-HU-03 à 05)', () => {
  it('ne montre au partenaire que ses assignations et les pièces marquées visibles', async () => {
    const world = litigationWorld();
    const { record, assignment } = await caseWithBailiff(world);
    const id = assignment.assignment.id;
    const mine = await asPartner(BAILIFF_USER_ID, () =>
      world.useCases.listMyAssignments.execute({ statuses: [] }),
    );
    expect(mine.items.map((item) => [item.assignment.id, item.caseNumber])).toEqual([[id, record.number]]);

    const file = await asPartner(BAILIFF_USER_ID, () =>
      world.useCases.getMyAssignment.execute({ assignmentId: id }),
    );
    expect(file.documents.length).toBeGreaterThan(0);
    expect(file.documents.every((document) => document.visibleToPartner)).toBe(true);
    expect(file.documents.some((document) => document.kind === 'fee_quote')).toBe(false);
    expect(file.caseView.record.debtors[0]?.contacts.length).toBeGreaterThan(0);
    expect(file.caseView.creditorName).toBe('Awa Dossou');
    expect(file.notices).toHaveLength(1);
    expect(world.deps.audit.entries.at(-1)).toMatchObject({
      actorId: BAILIFF_USER_ID,
      action: 'case.viewed_by_partner',
      entityId: record.id,
    });

    // Un autre partenaire, un compte sans fiche, un rôle du back-office : rien.
    await activePartner(world, 'partner-0002', {
      name: 'Me Autre',
      userId: OTHER_BAILIFF_USER_ID,
      verificationFileId: VERIFICATION_FILE_2,
    });
    for (const user of [OTHER_BAILIFF_USER_ID, '0192f1c4-0000-7000-8000-0000000b0000']) {
      expect(
        await rejection(asPartner(user, () => world.useCases.getMyAssignment.execute({ assignmentId: id }))),
      ).toMatchObject({ code: 'RECOVERY_ASSIGNMENT_NOT_FOUND' });
      expect(await rejection(recordAct(world, id, {}, user))).toMatchObject({
        code: 'RECOVERY_ASSIGNMENT_NOT_FOUND',
      });
      expect(
        (await asPartner(user, () => world.useCases.listMyAssignments.execute({ statuses: [] }))).items,
      ).toEqual([]);
    }
    expect(
      await rejection(asAgent(world, () => world.useCases.listMyAssignments.execute({ statuses: [] }))),
    ).toMatchObject({ code: 'AUTH_FORBIDDEN' });
    expect(
      await rejection(
        asPartner(BAILIFF_USER_ID, () =>
          world.useCases.getMyAssignment.execute({ assignmentId: 'pas-un-identifiant' }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_ASSIGNMENT_NOT_FOUND' });
  });

  it('enregistre les actes : provision consommée, dépassement signalé au juriste, événement sans donnée personnelle', async () => {
    const world = litigationWorld();
    const { record, partner, assignment } = await caseWithBailiff(world);
    const id = assignment.assignment.id;
    at(world, '2026-12-08T09:00:00.000Z');
    const act = await recordAct(world, id);
    expect(act).toMatchObject({
      type: 'summons_to_pay',
      cost: 35_000,
      fileId: ACT_FILE,
      nextStepDate: '2026-12-21',
    });
    expect(caseOf(world, record.id).documents.find((d) => d.kind === 'legal_act')).toMatchObject({
      fileId: ACT_FILE,
      visibleToPartner: true,
      visibleToDebtor: false,
    });
    expect(world.litigation.assignmentRows.get(id)?.lastUpdateAt).toEqual(
      new Date('2026-12-08T09:00:00.000Z'),
    );
    expect(eventsOf(world, 'recovery.partner.act_recorded').at(-1)?.payload).toEqual({
      caseId: record.id,
      caseNumber: record.number,
      creditor: record.creditor,
      actId: act.id,
      assignmentId: id,
      partnerId: partner.partner.id,
      actType: 'summons_to_pay',
      actDate: '2026-12-07',
      cost: { amount: 35_000, currency: 'XOF' },
      recordedAt: '2026-12-08T09:00:00.000Z',
    });
    // Rejoué avec la même clé : le même acte ; autre acte sous la même clé : refusé.
    expect((await recordAct(world, id)).id).toBe(act.id);
    expect(await rejection(recordAct(world, id, { type: 'seizure' }))).toMatchObject({
      code: 'RECOVERY_IDEMPOTENCY_KEY_REUSED',
    });
    await recordAct(world, id, { idempotencyKey: 'act-key-0002', type: 'service', cost: 40_000, fileId: '' });
    expect([...world.litigation.provisionRows.values()][0]?.consumed).toBe(60_000);
    const overrun = world.deps.cases.evidence.find((entry) => entry.action === 'provision.overrun');
    expect(overrun).toMatchObject({ internal: true, amount: 15_000 });
    expect(
      await rejection(recordAct(world, id, { idempotencyKey: 'act-key-0003', actDate: '2026-12-31' })),
    ).toMatchObject({ details: { field: 'actDate' } });
  });

  it('déclare une somme encaissée : imputée seulement après la validation de la finance (ADR-060, point 8)', async () => {
    const world = litigationWorld();
    const { record, partner, assignment } = await caseWithBailiff(world);
    const declared = await asPartner(BAILIFF_USER_ID, () =>
      world.useCases.declarePartnerCollection.execute({
        assignmentId: assignment.assignment.id,
        idempotencyKey: 'collect-0001',
        amount: 100_000,
        receivedOn: '2026-12-06',
        proofFileId: '',
        note: 'Saisie-vente',
      }),
    );
    expect(declared.payment).toMatchObject({
      source: 'partner',
      status: 'pending_approval',
      amount: 100_000,
      partnerId: partner.partner.id,
      assignmentId: assignment.assignment.id,
      recordedBy: BAILIFF_USER_ID,
    });
    expect(caseOf(world, record.id).paid).toBe(record.paid);
    expect(
      world.deps.cases.evidence.find((e) => e.action === 'partner.collection_declared')?.summary,
    ).toContain('à virer à KSP au plus tard le 14 décembre 2026');
    const approved = await asStaffNow(world, FINANCE_ID, ['finance_officer'], () =>
      world.useCases.approveOfflinePayment.execute({ offlinePaymentId: declared.payment.id }),
    );
    expect(approved.collection).toMatchObject({ source: 'partner', gross: 100_000 });
    expect(caseOf(world, record.id).paid).toBe(record.paid + 100_000);
    // Rejouée avec la même clé : la même déclaration.
    const again = await asPartner(BAILIFF_USER_ID, () =>
      world.useCases.declarePartnerCollection.execute({
        assignmentId: assignment.assignment.id,
        idempotencyKey: 'collect-0001',
        amount: 100_000,
        receivedOn: '2026-12-06',
        proofFileId: '',
        note: 'Saisie-vente',
      }),
    );
    expect(again.payment.id).toBe(declared.payment.id);
  });

  it('alerte le juriste une fois quand le partenaire reste sans nouvelles (R-HU-04)', async () => {
    const world = litigationWorld();
    await caseWithBailiff(world);
    at(world, '2026-12-21T09:00:00.000Z');
    expect((await world.useCases.watchLitigation.execute()).partnersSilent).toBe(0);
    at(world, '2026-12-22T09:00:00.000Z');
    expect((await world.useCases.watchLitigation.execute()).partnersSilent).toBe(1);
    expect((await world.useCases.watchLitigation.execute()).partnersSilent).toBe(0);
    expect(world.deps.cases.evidence.find((e) => e.action === 'partner.silent')).toMatchObject({
      internal: true,
    });
  });
});
