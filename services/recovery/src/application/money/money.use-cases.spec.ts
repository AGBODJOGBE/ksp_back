import { type RecoveryCaseRecord } from '../cases/ports';
import { DebtorLinks } from '../debtor-access/debtor-links.service';
import { CaseBackedDebtorReader } from '../testing/amicable-fakes';
import { type MemoryDebtorAccessStore } from '../testing/debtor-access.fakes';
import { asCreditor, asStaff, CREDITOR_ID, rejection } from '../testing/fakes';
import {
  activeCase,
  asFinance,
  debtorScope,
  FINANCE_A,
  FINANCE_B,
  moneyWorld,
  type MoneyWorld,
  payLink,
} from '../testing/money-scenarios';

describe('argent du recouvrement (R3 : UC-RC-11, 22, 28 ; ADR-060 points 4 à 11)', () => {
  let world: MoneyWorld;
  let record: RecoveryCaseRecord;

  beforeEach(async () => {
    world = moneyWorld();
    record = await activeCase(world);
  });

  const requestLink = (amount: number, key = 'pay-key-0001') =>
    world.useCases.createDebtorPayment.execute({
      ...debtorScope(record),
      idempotencyKey: key,
      amount,
      settlementId: '',
    });
  const eventsOf = (type: string) => world.deps.cases.events.filter((event) => event.type === type);
  const current = async () => (await world.deps.cases.find(record.id))!;
  const recordOffline = (amount: number, key = 'offline-key-01', userId = FINANCE_A) =>
    asFinance(userId, () =>
      world.useCases.recordOfflinePayment.execute({
        caseId: record.id,
        idempotencyKey: key,
        source: 'cash',
        amount,
        receivedOn: '2026-11-19',
        reference: 'CAISSE-0042',
        proofFileId: '',
      }),
    );

  describe('encaissement par lien (payment.link.paid)', () => {
    it('impute, commissionne, crédite le net tout de suite, publie et remet un reçu', async () => {
      await requestLink(100_000);
      expect(await payLink(world, record)).toBe('recorded');

      const [collection] = await world.money.collections(record.id);
      expect(collection).toMatchObject({
        source: 'payment_link',
        gross: 100_000,
        allocatedPrincipal: 100_000,
        commission: 10_000,
        net: 90_000,
        settlement: 'deducted',
        stage: 'notice',
        dueBefore: 750_000,
      });
      expect(collection!.creditedAt).not.toBeNull();
      expect([...world.moneyWallet.collections.values()]).toEqual([
        expect.objectContaining({
          holder: { type: 'user', id: CREDITOR_ID },
          gross: 100_000,
          commission: 10_000,
        }),
      ]);
      expect((await current()).paid).toBe(100_000);

      const [collected] = eventsOf('recovery.payment.collected');
      expect(collected!.payload).toMatchObject({
        source: 'payment_link',
        commission: { amount: 10_000, currency: 'XOF' },
        commissionSettlement: 'deducted',
        amountDueAfter: { amount: 650_000, currency: 'XOF' },
      });
      expect(JSON.stringify(collected!.payload)).not.toMatch(/Négoce|97000101|negoce/i);
      expect(eventsOf('recovery.remittance.paid')[0]!.payload).toMatchObject({
        net: { amount: 90_000, currency: 'XOF' },
        walletTransactionId: collection!.walletTransactionId,
      });

      const receipt = world.documents.generated.get(`recovery:receipt:${collection!.id}`);
      expect(receipt?.variables).toMatchObject({
        payment: { amount: 100_000, method: 'mobile_money' },
        dueBefore: 750_000,
        creditor: { name: 'Awa Créancière' },
      });
      expect((await current()).documents).toContainEqual(
        expect.objectContaining({ kind: 'receipt', documentId: receipt!.id, visibleToDebtor: true }),
      );
      expect([...world.money.paymentRequests.values()][0]!.status).toBe('paid');
    });

    it('rejoué, l’événement ne compte qu’une fois ; un autre objet payable est ignoré', async () => {
      await requestLink(100_000);
      const request = [...world.money.paymentRequests.values()][0]!;
      const event = {
        eventId: '0192f1c4-0000-7000-8e00-0000000000aa',
        paymentId: '0192f1c4-0000-7000-8f00-0000000000aa',
        subjectType: 'recovery_payment_request',
        subjectId: request.id,
        amount: 100_000,
        providerReference: null,
        paidAt: '2026-11-20T10:00:00.000Z',
      };
      expect(await world.useCases.recordLinkPayment.execute(event)).toBe('recorded');
      expect(await world.useCases.recordLinkPayment.execute(event)).toBe('duplicate');
      expect(
        await world.useCases.recordLinkPayment.execute({
          ...event,
          eventId: '0192f1c4-0000-7000-8e00-0000000000ab',
        }),
      ).toBe('duplicate');
      expect(
        await world.useCases.recordLinkPayment.execute({ ...event, subjectType: 'billing_payment' }),
      ).toBe('ignored');
      expect(world.money.collectionsById.size).toBe(1);
      expect(world.moneyWallet.collections.size).toBe(1);
    });

    it('wallet injoignable : l’encaissement est gardé, la tâche crédite ensuite', async () => {
      await requestLink(100_000);
      world.moneyWallet.collectionFailures = 1;
      await payLink(world, record);
      expect([...world.money.collectionsById.values()][0]!.creditedAt).toBeNull();
      expect(eventsOf('recovery.remittance.paid')).toHaveLength(0);

      const report = await world.useCases.resumeMoneyEffects.execute();
      expect(report).toMatchObject({ settled: 1, failed: 0 });
      expect([...world.money.collectionsById.values()][0]!.creditedAt).not.toBeNull();
      expect(eventsOf('recovery.remittance.paid')).toHaveLength(1);
    });
  });

  describe('paiement complet et clôture', () => {
    it('le dû à zéro clôt le dossier : attestation, liens en lecture seule, recovery.case.closed', async () => {
      const debtorId = record.debtors[0]!.id;
      world.deps.debtorAccess.reader = new CaseBackedDebtorReader(
        world.deps.cases,
        world.deps.personalData,
        world.money,
      );
      const before = await new DebtorLinks(world.deps).issue({ caseId: record.id, debtorId });
      await requestLink(750_000);
      await payLink(world, record);

      const closed = await current();
      expect(closed).toMatchObject({ status: 'closed', closureReason: 'paid', paid: 750_000 });
      const certificate = world.documents.generated.get(`recovery:settlement-certificate:${record.id}`);
      expect(certificate?.variables).toMatchObject({ closure: 'paid_in_full', totalPaid: 750_000 });
      expect(eventsOf('recovery.case.closed')[0]!.payload).toMatchObject({
        reason: 'paid',
        totalCollected: { amount: 750_000, currency: 'XOF' },
        settlementCertificateDocumentId: certificate!.id,
      });
      // Lien neuf en lecture seule (attestation et reçus), valable 30 jours après la clôture, remis avec
      // l'attestation ; l'ancien est révoqué.
      const active = (world.deps.debtorAccess.store as MemoryDebtorAccessStore).activeOf(debtorId)!;
      expect(active.id).not.toBe(before.accessId);
      const closedAt = (await world.money.money(record.id)).closure!.closedAt;
      expect(active.link.expiresAt).toEqual(new Date(closedAt.getTime() + 30 * 86_400_000));
      expect(world.notifier.sent.get(`settlement-certificate:${record.id}:${active.id}`)).toMatchObject({
        message: 'settlement_certificate',
        channel: 'whatsapp',
        variables: { link: expect.stringMatching(/^https:\/\/ksp\.bj\/recouvrement\/[A-Za-z0-9_-]{43}$/) },
      });
      expect((await world.money.money(record.id)).closure?.completedAt).not.toBeNull();
      // Le minimum de commission au cumul : aucune borne ici, 10 % du tout.
      expect([...world.money.collectionsById.values()][0]!.commission).toBe(75_000);
    });

    it('deux paiements simultanés : le trop-perçu est noté, remboursé à la main par la finance', async () => {
      await recordOffline(750_000);
      await requestLink(100_000);
      await payLink(world, record);
      const pending = [...world.money.offlinePayments.values()][0]!;
      await asFinance(FINANCE_B, () =>
        world.useCases.approveOfflinePayment.execute({ offlinePaymentId: pending.id }),
      );
      expect((await current()).status).toBe('closed');
      const money = await world.money.money(record.id);
      expect(money.overpaid).toBe(100_000);

      const refund = (amount: number, key = 'refund-key-01') =>
        asFinance(FINANCE_A, () =>
          world.useCases.recordOverpaymentRefund.execute({
            caseId: record.id,
            idempotencyKey: key,
            amount,
            reference: 'MOMO-778899',
            note: '',
          }),
        );
      expect(await rejection(refund(150_000))).toMatchObject({ code: 'RECOVERY_PAYMENT_AMOUNT_INVALID' });
      const view = await refund(100_000);
      expect(view.view.amounts.overpaid).toBe(0);
      expect((await refund(100_000)).view.amounts.overpaid).toBe(0);
      expect(world.money.refunds.size).toBe(1);
    });
  });

  describe('paiements hors ligne : validation à deux (R-AR-03)', () => {
    it('saisi par la finance, validé par une autre personne, imputé et crédité à la validation', async () => {
      const recorded = await recordOffline(200_000);
      expect(recorded.payment.status).toBe('pending_approval');
      expect((await current()).paid).toBe(0);
      expect((await recordOffline(200_000)).payment.id).toBe(recorded.payment.id);

      expect(
        await rejection(
          asFinance(FINANCE_A, () =>
            world.useCases.approveOfflinePayment.execute({ offlinePaymentId: recorded.payment.id }),
          ),
        ),
      ).toMatchObject({ code: 'RECOVERY_APPROVAL_BY_REQUESTER' });
      expect(
        await rejection(
          asFinance(
            FINANCE_B,
            () => world.useCases.approveOfflinePayment.execute({ offlinePaymentId: recorded.payment.id }),
            900,
          ),
        ),
      ).toMatchObject({ code: 'AUTH_MFA_REQUIRED' });

      const approved = await asFinance(FINANCE_B, () =>
        world.useCases.approveOfflinePayment.execute({ offlinePaymentId: recorded.payment.id }),
      );
      expect(approved.payment.payment).toMatchObject({ status: 'approved', reviewedBy: FINANCE_B });
      expect(approved.collection).toMatchObject({
        source: 'offline_cash',
        gross: 200_000,
        commission: 20_000,
      });
      expect(approved.collection.receipt).toEqual({ method: 'cash', reference: 'CAISSE-0042' });
      expect((await current()).paid).toBe(200_000);
      expect(world.deps.cases.audit.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(['offline_payment.recorded', 'offline_payment.approved', 'remittance.paid']),
      );
      // Rejouée par la même personne, la validation rend l'encaissement créé.
      const again = await asFinance(FINANCE_B, () =>
        world.useCases.approveOfflinePayment.execute({ offlinePaymentId: recorded.payment.id }),
      );
      expect(again.collection.id).toBe(approved.collection.id);
      expect(world.money.collectionsById.size).toBe(1);
    });

    it('refus motivé par une autre personne, liste des paiements à valider', async () => {
      const first = await recordOffline(50_000, 'offline-key-01');
      await recordOffline(60_000, 'offline-key-02');
      const listed = await asFinance(FINANCE_B, () =>
        world.useCases.listOfflinePayments.execute({ statuses: [], caseId: '' }),
      );
      expect(listed.items.map((item) => item.payment.amount)).toEqual([50_000, 60_000]);
      expect(listed.items[0]!.caseNumber).toBe(record.number);

      const rejected = await asFinance(FINANCE_B, () =>
        world.useCases.rejectOfflinePayment.execute({
          offlinePaymentId: first.payment.id,
          reason: 'Bordereau introuvable en caisse',
        }),
      );
      expect(rejected.payment).toMatchObject({
        status: 'rejected',
        rejectionReason: 'Bordereau introuvable en caisse',
      });
      expect(
        await rejection(
          asFinance(FINANCE_B, () =>
            world.useCases.approveOfflinePayment.execute({ offlinePaymentId: first.payment.id }),
          ),
        ),
      ).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
      expect(world.money.collectionsById.size).toBe(0);
    });

    it('réservé à la finance ; montant au plus le dû ; partenaire déclaré depuis son accès', async () => {
      expect(
        await rejection(
          asStaff('0192f1c4-0000-7000-8000-00000000a6e1', ['recovery_agent'], () =>
            world.useCases.recordOfflinePayment.execute({
              caseId: record.id,
              idempotencyKey: 'offline-key-01',
              source: 'cash',
              amount: 1_000,
              receivedOn: '2026-11-19',
              reference: '',
              proofFileId: '',
            }),
          ),
        ),
      ).toMatchObject({ code: 'AUTH_FORBIDDEN' });
      expect(await rejection(recordOffline(800_000))).toMatchObject({
        code: 'RECOVERY_PAYMENT_AMOUNT_INVALID',
        details: { due: { amount: 750_000, currency: 'XOF' } },
      });
      expect(
        await rejection(
          asFinance(FINANCE_A, () =>
            world.useCases.recordOfflinePayment.execute({
              caseId: record.id,
              idempotencyKey: 'offline-key-03',
              source: 'partner',
              amount: 1_000,
              receivedOn: '2026-11-19',
              reference: '',
              proofFileId: '',
            }),
          ),
        ),
      ).toMatchObject({ code: 'RECOVERY_VALIDATION_FAILED', details: { field: 'source' } });
    });
  });

  describe('paiement direct au créancier (R-PR-07) et reversements', () => {
    const declare = (amount: number, key = 'direct-key-01') =>
      asCreditor(() =>
        world.useCases.declareDirectPayment.execute({
          caseId: record.id,
          idempotencyKey: key,
          amount,
          receivedOn: '2026-11-18',
          note: 'Remis en main propre',
          proofFileId: '0192f1c4-0000-7000-8000-0000000f0002',
        }),
      );

    it('imputé, commission facturée, rien de crédité ni de reçu', async () => {
      const result = await declare(50_000);
      expect(result.collection).toMatchObject({
        source: 'direct_to_creditor',
        settlement: 'invoiced',
        commission: 5_000,
        net: 0,
        receipt: null,
      });
      expect(result.view.view.amounts.due).toBe(700_000);
      expect(world.moneyWallet.collections.size).toBe(0);
      expect(eventsOf('recovery.payment.collected')[0]!.payload).toMatchObject({
        source: 'direct_to_creditor',
        commissionSettlement: 'invoiced',
      });
      expect(eventsOf('recovery.remittance.paid')).toHaveLength(0);
      expect(result.view.view.record.documents).toContainEqual(
        expect.objectContaining({ fileId: '0192f1c4-0000-7000-8000-0000000f0002', kind: 'evidence' }),
      );
      expect((await declare(50_000)).collection.id).toBe(result.collection.id);
      expect(await rejection(declare(800_000, 'direct-key-02'))).toMatchObject({
        code: 'RECOVERY_PAYMENT_AMOUNT_INVALID',
      });
    });

    it('reversements du créancier : encaissements crédités, les plus récents d’abord', async () => {
      await declare(50_000);
      await requestLink(100_000);
      await payLink(world, record);
      const listed = await asCreditor(() =>
        world.useCases.listMyRemittances.execute({ caseId: record.id, from: '2026-11-01', to: '', page: {} }),
      );
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({
        caseNumber: record.number,
        collection: { source: 'payment_link', net: 90_000 },
      });
      expect(
        (
          await asCreditor(() =>
            world.useCases.listMyRemittances.execute({ caseId: '', from: '', to: '2026-10-31', page: {} }),
          )
        ).items,
      ).toHaveLength(0);
    });
  });
});
