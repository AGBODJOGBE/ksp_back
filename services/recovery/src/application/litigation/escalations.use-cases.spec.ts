import { activeCase, asAgent, eventsOf } from '../testing/amicable-scenarios';
import { asCreditor, CREDITOR_ID, rejection } from '../testing/fakes';
import {
  activePartner,
  answer,
  asLegal,
  at,
  caseAtFormalNotice,
  caseOf,
  expiredNotice,
  LAWYER_USER_ID,
  LEGAL_OFFICER_ID,
  litigationWorld,
  partnerInput,
  PROOF_FILE,
  requestBailiff,
  VERIFICATION_FILE_2,
} from '../testing/litigation-scenarios';

describe('mise en demeure (UC-RC-19)', () => {
  it('émet la mise en demeure signée par le juriste, annoncée au débiteur et au créancier', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const issued = await asLegal(world, () =>
      world.useCases.issueFormalNotice.execute({
        caseId: record.id,
        idempotencyKey: 'notice-0001',
        deadlineDays: 0,
      }),
    );
    expect(issued.notice).toMatchObject({
      kind: 'formal_notice',
      signedBy: LEGAL_OFFICER_ID,
      deadlineDays: 15,
      deliveredAt: null,
    });
    expect(issued.signedByName).toBe('Me Kossi Juriste');
    const generated = world.documents.generated.get(`recovery:formal-notice:${issued.notice.id}`)!;
    expect(generated.variables).toMatchObject({
      caseReference: record.number,
      creditor: { name: 'Awa Dossou' },
      claim: { principal: 750_000 },
      paymentDeadlineDays: 15,
    });
    expect(caseOf(world, record.id).documents.find((d) => d.kind === 'formal_notice')).toMatchObject({
      documentId: issued.notice.documentId,
      visibleToDebtor: true,
      visibleToPartner: true,
    });
    const [event] = eventsOf(world, 'recovery.notice.issued');
    expect(event?.payload).toEqual({
      caseId: record.id,
      caseNumber: record.number,
      creditor: record.creditor,
      noticeId: issued.notice.id,
      documentId: issued.notice.documentId,
      deadlineDays: 15,
      issuedAt: '2026-11-20T09:00:00.000Z',
    });
    const messages = [...world.store.messages.values()].filter((m) => m.purpose === 'formal_notice');
    expect(messages).toEqual([
      expect.objectContaining({ message: 'formal_notice', variables: { deadline_days: '15' } }),
    ]);

    // Rejouée avec la même clé : la même mise en demeure, un seul message.
    const again = await asLegal(world, () =>
      world.useCases.issueFormalNotice.execute({
        caseId: record.id,
        idempotencyKey: 'notice-0001',
        deadlineDays: 0,
      }),
    );
    expect(again.notice.id).toBe(issued.notice.id);
    expect([...world.store.messages.values()].filter((m) => m.purpose === 'formal_notice')).toHaveLength(1);
    expect(eventsOf(world, 'recovery.notice.issued')).toHaveLength(1);
  });

  it('refuse la mise en demeure hors de son étape, hors bornes ou sans le rôle du juriste', async () => {
    const early = litigationWorld();
    const notice = await activeCase(early, 'case-key-0001');
    expect(
      await rejection(
        asLegal(early, () =>
          early.useCases.issueFormalNotice.execute({
            caseId: notice.id,
            idempotencyKey: 'notice-0001',
            deadlineDays: 15,
          }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    expect(
      await rejection(
        asLegal(world, () =>
          world.useCases.issueFormalNotice.execute({
            caseId: record.id,
            idempotencyKey: 'notice-0002',
            deadlineDays: 5,
          }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'deadlineDays' } });
    expect(
      await rejection(
        asAgent(world, () =>
          world.useCases.issueFormalNotice.execute({
            caseId: record.id,
            idempotencyKey: 'notice-0003',
            deadlineDays: 15,
          }),
        ),
      ),
    ).toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });

  it('enregistre la preuve de remise : le délai du débiteur court de la remise', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const issued = await asLegal(world, () =>
      world.useCases.issueFormalNotice.execute({
        caseId: record.id,
        idempotencyKey: 'notice-0001',
        deadlineDays: 20,
      }),
    );
    at(world, '2026-11-22T10:00:00.000Z');
    const delivery = {
      caseId: record.id,
      noticeId: issued.notice.id,
      deliveryMethod: 'hand_delivery',
      deliveredAt: '2026-11-22T08:30:00.000Z',
      proofFileId: PROOF_FILE,
    };
    expect(
      await rejection(
        asLegal(world, () =>
          world.useCases.recordNoticeDelivery.execute({
            ...delivery,
            deliveredAt: '2026-11-23T08:30:00.000Z',
          }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'deliveredAt' } });
    const delivered = await asLegal(world, () => world.useCases.recordNoticeDelivery.execute(delivery));
    expect(delivered.notice).toMatchObject({
      deliveryMethod: 'hand_delivery',
      deliveredAt: new Date('2026-11-22T08:30:00.000Z'),
      deadlineAt: new Date('2026-12-12T08:30:00.000Z'),
      proofFileId: PROOF_FILE,
    });
    expect(world.files.subjects.get(PROOF_FILE)).toEqual({ type: 'recovery_case', id: record.id });
    expect(caseOf(world, record.id).documents.find((d) => d.kind === 'notice_delivery_proof')).toMatchObject({
      fileId: PROOF_FILE,
      visibleToPartner: true,
      visibleToDebtor: false,
    });
    // Rejouée à l'identique : rendue telle quelle ; autre remise : refusée.
    expect(
      (await asLegal(world, () => world.useCases.recordNoticeDelivery.execute(delivery))).notice.id,
    ).toBe(issued.notice.id);
    expect(
      await rejection(
        asLegal(world, () =>
          world.useCases.recordNoticeDelivery.execute({ ...delivery, deliveryMethod: 'email' }),
        ),
      ),
    ).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
  });

  it("propose l'huissier une fois, au terme du délai de la mise en demeure (tâche du contentieux)", async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const issued = await asLegal(world, () =>
      world.useCases.issueFormalNotice.execute({
        caseId: record.id,
        idempotencyKey: 'notice-0001',
        deadlineDays: 15,
      }),
    );
    at(world, '2026-11-20T11:00:00.000Z');
    await asLegal(world, () =>
      world.useCases.recordNoticeDelivery.execute({
        caseId: record.id,
        noticeId: issued.notice.id,
        deliveryMethod: 'registered_mail',
        deliveredAt: '2026-11-20T10:00:00.000Z',
        proofFileId: PROOF_FILE,
      }),
    );
    at(world, '2026-12-05T09:00:00.000Z');
    expect((await world.useCases.watchLitigation.execute()).escalationsProposed).toBe(0);
    at(world, '2026-12-05T10:00:00.000Z');
    expect((await world.useCases.watchLitigation.execute()).escalationsProposed).toBe(1);
    expect((await world.useCases.watchLitigation.execute()).escalationsProposed).toBe(0);
    expect(world.deps.cases.evidence.filter((e) => e.action === 'stage.bailiff_proposed')).toHaveLength(1);
  });
});

describe('étapes payantes : devis et provision du créancier (R-PR-04)', () => {
  it('soumet le devis au créancier : décision de 15 jours, PDF, provision égale au total', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    await expiredNotice(world, record.id);
    const escalation = await requestBailiff(world, record.id, partner.partner.id);
    expect(escalation.quote.quote).toMatchObject({
      stage: 'bailiff',
      total: 60_000,
      provision: 60_000,
      status: 'pending',
      partnerId: partner.partner.id,
    });
    expect(escalation.quote.partner).toMatchObject({ name: 'Me Adjovi', kind: 'bailiff' });
    expect(escalation.decision.decision).toMatchObject({
      kind: 'bailiff_escalation',
      status: 'pending',
      payload: { feeQuoteId: escalation.quote.quote.id },
      expiresAt: new Date('2026-12-22T09:00:00.000Z'),
    });
    const generated = world.documents.generated.get(`recovery:fee-quote:${escalation.quote.quote.id}`)!;
    expect(generated.variables).toMatchObject({
      stage: 'bailiff',
      amountDue: 750_000,
      total: 60_000,
      provision: 60_000,
      acceptBy: '2026-12-22',
      lines: [
        { category: 'bailiff', label: 'Sommation de payer', amount: 35_000 },
        { category: 'bailiff', label: 'Frais de déplacement', amount: 25_000 },
      ],
    });
    expect(eventsOf(world, 'recovery.decision.requested').at(-1)?.payload).toMatchObject({
      decisionId: escalation.decision.decision.id,
      kind: 'bailiff_escalation',
    });
    // Le créancier voit le devis et le partenaire avec la décision (R-HU-02).
    const listed = await asCreditor(() =>
      world.useCases.listMyDecisions.execute({ statuses: [], caseId: record.id }),
    );
    expect(listed.items[0]?.feeQuote).toMatchObject({
      quote: { total: 60_000 },
      partner: { name: 'Me Adjovi' },
    });
    // Rejoué avec la même clé : le même devis ; un autre devis attend la réponse.
    const again = await requestBailiff(world, record.id, partner.partner.id);
    expect(again.quote.quote.id).toBe(escalation.quote.quote.id);
    expect(await rejection(requestBailiff(world, record.id, partner.partner.id, 'quote-0002'))).toMatchObject(
      {
        code: 'RECOVERY_INVALID_TRANSITION',
      },
    );
  });

  it('refuse le devis avant la fin du délai, avec un partenaire inactif ou du mauvais métier', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    expect(await rejection(requestBailiff(world, record.id, partner.partner.id))).toMatchObject({
      code: 'RECOVERY_INVALID_TRANSITION',
    });
    await expiredNotice(world, record.id);
    const lawyer = await activePartner(world, 'partner-0002', {
      kind: 'lawyer',
      userId: LAWYER_USER_ID,
      name: 'Me Avocat',
      verificationFileId: VERIFICATION_FILE_2,
    });
    expect(await rejection(requestBailiff(world, record.id, lawyer.partner.id, 'quote-0002'))).toMatchObject({
      code: 'RECOVERY_VALIDATION_FAILED',
      details: { field: 'partnerId' },
    });
    const pending = await asLegal(world, () =>
      world.useCases.createPartner.execute({
        idempotencyKey: 'partner-0003',
        input: partnerInput({ userId: '', name: 'Me Attente', verificationFileId: '' }),
      }),
    );
    expect(await rejection(requestBailiff(world, record.id, pending.partner.id, 'quote-0003'))).toMatchObject(
      {
        code: 'RECOVERY_PARTNER_NOT_ACTIVE',
      },
    );
  });

  it('acceptation : provision débitée du portefeuille, étape huissier ouverte, rejouable sans double débit', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    await expiredNotice(world, record.id);
    const escalation = await requestBailiff(world, record.id, partner.partner.id);
    const before = world.wallet.balances.get(CREDITOR_ID)!;
    const result = await answer(world, escalation.decision.decision.id, 'approve');
    expect(result.decision.decision.status).toBe('approved');
    expect(result.decision.feeQuote?.quote.status).toBe('accepted');
    expect(result.view.record).toMatchObject({ stage: 'bailiff', highestStage: 'bailiff' });
    expect(world.wallet.balances.get(CREDITOR_ID)).toBe(before - 60_000);
    expect([...world.wallet.debits.values()].at(-1)).toMatchObject({
      amount: 60_000,
      objectType: 'recovery_provision',
      objectId: escalation.quote.quote.id,
      holder: { type: 'user', id: CREDITOR_ID },
    });
    expect([...world.litigation.provisionRows.values()]).toEqual([
      expect.objectContaining({
        amount: 60_000,
        consumed: 0,
        status: 'paid',
        feeQuoteId: escalation.quote.quote.id,
      }),
    ]);
    expect(eventsOf(world, 'recovery.case.stage_changed').at(-1)?.payload).toMatchObject({
      fromStage: 'formal_notice',
      toStage: 'bailiff',
    });
    await answer(world, escalation.decision.decision.id, 'approve');
    expect(world.wallet.balances.get(CREDITOR_ID)).toBe(before - 60_000);
  });

  it('solde insuffisant : RECOVERY_INSUFFICIENT_FUNDS, puis acceptée avec la même clé après la recharge', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    await expiredNotice(world, record.id);
    const escalation = await requestBailiff(world, record.id, partner.partner.id);
    world.wallet.balances.set(CREDITOR_ID, 10_000);
    expect(await rejection(answer(world, escalation.decision.decision.id, 'approve'))).toMatchObject({
      code: 'RECOVERY_INSUFFICIENT_FUNDS',
      details: { missing: { amount: 50_000, currency: 'XOF' } },
    });
    expect(caseOf(world, record.id).stage).toBe('formal_notice');
    world.wallet.balances.set(CREDITOR_ID, 70_000);
    await answer(world, escalation.decision.decision.id, 'approve');
    expect(caseOf(world, record.id).stage).toBe('bailiff');
    expect(world.wallet.balances.get(CREDITOR_ID)).toBe(10_000);
  });

  it('refus : devis refusé, le dossier reste à la mise en demeure sans débit', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    await expiredNotice(world, record.id);
    const escalation = await requestBailiff(world, record.id, partner.partner.id);
    const result = await answer(world, escalation.decision.decision.id, 'reject');
    expect(result.decision.decision.status).toBe('rejected');
    expect(result.decision.feeQuote?.quote.status).toBe('rejected');
    expect(caseOf(world, record.id)).toMatchObject({ status: 'active', stage: 'formal_notice' });
    expect(world.wallet.debits.size).toBe(1); // frais de dossier seulement
  });

  it('sans réponse dans le délai : dossier clos « abandon par le créancier » par le service de clôture', async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    await expiredNotice(world, record.id);
    const escalation = await requestBailiff(world, record.id, partner.partner.id);
    at(world, '2026-12-23T09:00:00.000Z');
    const report = await world.useCases.watchAmicable.execute();
    expect(report.decisionsExpired).toBe(1);
    expect(caseOf(world, record.id)).toMatchObject({
      status: 'closed',
      closureReason: 'abandoned_by_creditor',
    });
    expect(world.money.closures.get(record.id)).toMatchObject({ closedBy: { type: 'system', id: null } });
    expect(eventsOf(world, 'recovery.case.closed').at(-1)?.payload).toMatchObject({
      reason: 'abandoned_by_creditor',
    });
    expect(world.litigation.quoteRows.get(escalation.quote.quote.id)?.status).toBe('expired');
    expect(world.store.decisionRows.get(escalation.decision.decision.id)?.status).toBe('expired');
  });

  it("provision complémentaire à l'étape huissier : nouvelle provision, sans changement d'étape", async () => {
    const world = litigationWorld();
    const record = await caseAtFormalNotice(world);
    const partner = await activePartner(world);
    await expiredNotice(world, record.id);
    const first = await requestBailiff(world, record.id, partner.partner.id);
    await answer(world, first.decision.decision.id, 'approve');
    const topUp = await requestBailiff(world, record.id, partner.partner.id, 'quote-0002');
    world.wallet.balances.set(CREDITOR_ID, 100_000);
    await answer(world, topUp.decision.decision.id, 'approve', 'answer-0002');
    expect(caseOf(world, record.id).stage).toBe('bailiff');
    expect([...world.litigation.provisionRows.values()].map((p) => p.amount)).toEqual([60_000, 60_000]);
    const toBailiff = eventsOf(world, 'recovery.case.stage_changed').filter(
      (event) => (event.payload as { toStage?: string }).toStage === 'bailiff',
    );
    expect(toBailiff).toHaveLength(1);
  });
});
