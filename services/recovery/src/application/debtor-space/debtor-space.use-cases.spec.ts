import { type RecoveryCaseRecord } from '../cases/ports';
import { LEGAL_ID } from '../testing/case-scenarios';
import { asStaff, rejection } from '../testing/fakes';
import { activeCase, debtorScope, moneyWorld, type MoneyWorld, payLink } from '../testing/money-scenarios';

describe('espace du débiteur et contestations (R3 : partie 7, UC-RC-10, 11, 13 ; R-PR-02)', () => {
  let world: MoneyWorld;
  let record: RecoveryCaseRecord;

  beforeEach(async () => {
    world = moneyWorld();
    record = await activeCase(world);
  });

  const scope = () => debtorScope(record);
  const current = async () => (await world.deps.cases.find(record.id))!;
  const eventsOf = (type: string) => world.deps.cases.events.filter((event) => event.type === type);
  const pay = (amount: number | null, key = 'pay-key-0001', settlementId = '') =>
    world.useCases.createDebtorPayment.execute({ ...scope(), idempotencyKey: key, amount, settlementId });
  const upload = async () => {
    const slot = await world.useCases.createDebtorUpload.execute({
      ...scope(),
      fileName: 'releve-banque.pdf',
      contentType: 'application/pdf',
      sizeBytes: 120_000,
    });
    return world.useCases.completeDebtorUpload.execute({ ...scope(), fileId: slot.fileId });
  };
  const dispute = (fileIds: string[] = [], key = 'dispute-key-01') =>
    world.useCases.disputeDebtorCase.execute({
      ...scope(),
      idempotencyKey: key,
      reason: 'already_paid',
      text: 'J’ai payé par virement le 2 octobre.',
      fileIds,
    });
  const resolve = (disputeId: string, resolution: string, correctedDue: number | null = null) =>
    asStaff(LEGAL_ID, ['legal_officer'], () =>
      world.useCases.resolveDispute.execute({
        caseId: record.id,
        disputeId,
        resolution,
        correctedDue,
        note: 'Pièces du créancier examinées',
      }),
    );

  describe('situation et paiement', () => {
    it('montre le dû détaillé, les paiements, les reçus et le lien en cours ; rien d’autre', async () => {
      await pay(100_000);
      await payLink(world, record);
      await pay(50_000, 'pay-key-0002');
      const view = await world.useCases.getDebtorCase.execute(scope());
      expect(view).toMatchObject({
        caseNumber: record.number,
        creditorName: 'Awa Créancière',
        nature: 'unpaid_invoice',
        references: ['F-2026-001', 'F-2026-002'],
        status: 'active',
        amounts: { principal: 750_000, paid: 100_000, due: 650_000, overpaid: 0 },
        pendingPaymentUrl: expect.stringMatching(/^https:\/\/ksp\.bj\/payer\//),
      });
      expect(view.payments).toEqual([
        expect.objectContaining({
          amount: 100_000,
          channel: 'online',
          receiptDocumentId: expect.any(String),
        }),
      ]);
      expect(view.documents.map((document) => document.kind)).toEqual(['receipt']);
    });

    it('lien plafonné au dû, le précédent révoqué, rejoué avec la même clé', async () => {
      expect(await rejection(pay(800_000))).toMatchObject({
        code: 'RECOVERY_PAYMENT_AMOUNT_INVALID',
        details: { due: { amount: 750_000, currency: 'XOF' } },
      });
      const first = await pay(100_000);
      expect(first.amount).toBe(100_000);
      expect((await pay(100_000)).url).toBe(first.url);
      expect(await rejection(pay(90_000))).toMatchObject({ code: 'RECOVERY_IDEMPOTENCY_KEY_REUSED' });
      await pay(200_000, 'pay-key-0002');
      const links = [...world.paymentLinks.links.values()];
      expect(links.map((link) => link.status)).toEqual(['revoked', 'active']);
      expect(
        await rejection(pay(null, 'pay-key-0003', '0192f1c4-0000-7000-8000-00000005e771')),
      ).toMatchObject({
        code: 'RECOVERY_VALIDATION_FAILED',
        details: { field: 'settlementId' },
      });
    });

    it('un lien précédent payé entre-temps empêche d’en créer un autre', async () => {
      const first = await pay(100_000);
      const link = [...world.paymentLinks.links.values()].find((candidate) => candidate.url === first.url)!;
      world.paymentLinks.markPaid(link.id, '2026-11-20T09:30:00.000Z');
      expect(await rejection(pay(100_000, 'pay-key-0002'))).toMatchObject({
        code: 'RECOVERY_INVALID_TRANSITION',
      });
    });
  });

  describe('pièces, contestation et suite', () => {
    it('pièce envoyée puis contestation : dossier suspendu, créancier prévenu, débiteur accusé', async () => {
      const file = await upload();
      expect(file.status).toBe('available');
      const opened = await dispute([file.fileId]);
      expect(opened).toMatchObject({ status: 'open', reason: 'already_paid', fileIds: [file.fileId] });
      expect((await current()).status).toBe('suspended');
      expect(eventsOf('recovery.case.suspended')[0]!.payload).toMatchObject({
        reason: 'dispute',
        disputeId: opened.id,
        creditorAnswerDueAt: '2026-11-30T09:00:00.000Z',
      });
      expect(JSON.stringify(world.deps.cases.events)).not.toContain('virement le 2 octobre');
      expect(world.notifier.sent.get(`dispute-received:${opened.id}`)?.message).toBe('dispute_received');
      expect((await dispute([file.fileId])).id).toBe(opened.id);
      expect(await rejection(dispute([], 'dispute-key-02'))).toMatchObject({
        code: 'RECOVERY_CASE_SUSPENDED',
      });
      expect(await rejection(pay(10_000))).toMatchObject({ code: 'RECOVERY_CASE_SUSPENDED' });
    });

    it('refuse une pièce inconnue ; une pièce rejetée par file ne rejoint pas le dossier', async () => {
      expect(await rejection(dispute(['0192f1c4-0000-7000-8000-0000000f0002']))).toMatchObject({
        code: 'RECOVERY_VALIDATION_FAILED',
        details: { field: 'fileIds' },
      });
      world.uploads.rejectNext = 1;
      expect((await upload()).status).toBe('rejected');
      expect(
        (await current()).documents.filter((document) => document.kind === 'dispute_evidence'),
      ).toHaveLength(0);
    });

    it('contestation rejetée : dossier repris', async () => {
      const opened = await dispute();
      const view = await resolve(opened.id, 'resume');
      expect(view.view.record.status).toBe('active');
      expect(view.disputes[0]).toMatchObject({ status: 'rejected', resolution: 'resume' });
      expect(eventsOf('recovery.case.resumed')[0]!.payload).toMatchObject({ resolution: 'resume' });
    });

    it('montant corrigé : principal réduit, liens au-delà du nouveau dû révoqués', async () => {
      await pay(700_000);
      const opened = await dispute();
      const view = await resolve(opened.id, 'correct_amount', 500_000);
      expect(view.view.amounts.due).toBe(500_000);
      expect(view.view.record.principal).toBe(500_000);
      expect([...world.paymentLinks.links.values()][0]!.status).toBe('revoked');
      expect(await rejection(resolve(opened.id, 'resume'))).toMatchObject({
        code: 'RECOVERY_DECISION_CLOSED',
      });
    });

    it('contestation fondée : dossier clos sans attestation, réservé au juriste', async () => {
      const opened = await dispute();
      expect(
        await rejection(
          asStaff('0192f1c4-0000-7000-8000-00000000a6e1', ['recovery_agent'], () =>
            world.useCases.resolveDispute.execute({
              caseId: record.id,
              disputeId: opened.id,
              resolution: 'close',
              correctedDue: null,
              note: 'Fondée',
            }),
          ),
        ),
      ).toMatchObject({ code: 'AUTH_FORBIDDEN' });
      const view = await resolve(opened.id, 'close');
      expect(view.view.record).toMatchObject({ status: 'closed', closureReason: 'dispute_upheld' });
      expect(eventsOf('recovery.case.closed')[0]!.payload).toMatchObject({
        reason: 'dispute_upheld',
        settlementCertificateDocumentId: null,
      });
    });
  });

  describe('rappel et documents', () => {
    it('rappel dans les plages de contact, un seul en attente', async () => {
      const callback = (from: string, to: string) =>
        world.useCases.requestDebtorCallback.execute({
          ...scope(),
          preferredFrom: from,
          preferredTo: to,
          message: 'Plutôt en fin de matinée',
        });
      expect(await rejection(callback('2026-11-21T20:00:00.000Z', '2026-11-21T21:00:00.000Z'))).toMatchObject(
        {
          code: 'RECOVERY_VALIDATION_FAILED',
        },
      );
      // Samedi 21 novembre 2026, 10 h – 11 h à Cotonou (UTC+1).
      expect(
        (await callback('2026-11-21T09:00:00.000Z', '2026-11-21T10:00:00.000Z')).requestedAt,
      ).toBeInstanceOf(Date);
      expect(await rejection(callback('2026-11-23T09:00:00.000Z', '2026-11-23T10:00:00.000Z'))).toMatchObject(
        {
          code: 'RECOVERY_INVALID_TRANSITION',
        },
      );
      const stored = [...world.money.callbacks.values()][0]!;
      expect(stored.message).toBe('Plutôt en fin de matinée');
      expect(JSON.stringify(world.deps.cases.evidence)).not.toContain('fin de matinée');
    });

    it('adresse de lecture d’un reçu, tracée ; jamais d’une pièce non montrée au débiteur', async () => {
      await pay(100_000);
      await payLink(world, record);
      const receipt = (await current()).documents.find((document) => document.kind === 'receipt')!;
      const url = await world.useCases.getDebtorDocumentUrl.execute({
        ...scope(),
        documentId: receipt.documentId!,
      });
      expect(url.url).toContain(receipt.documentId!);
      expect(world.deps.audit.entries).toContainEqual(
        expect.objectContaining({ action: 'debtor.document_downloaded', entityId: record.id }),
      );
      const evidence = (await current()).documents.find((document) => document.kind === 'evidence')!;
      expect(
        await rejection(
          world.useCases.getDebtorDocumentUrl.execute({ ...scope(), documentId: evidence.fileId! }),
        ),
      ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED' });
    });
  });
});
