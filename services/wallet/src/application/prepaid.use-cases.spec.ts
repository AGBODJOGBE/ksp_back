import { type AppError, runWithContext } from '@ksp/platform';
import {
  asCustomer,
  asService,
  asServiceFor,
  asStaff,
  makeDeps,
  ORGANIZATION_ID,
  STAFF_ID,
  USER_ID,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const USER = { type: 'user', id: USER_ID };
const ORG = { type: 'organization', id: ORGANIZATION_ID };
const MISSION_ID = '0192f1c4-0000-7000-8000-00000000e001';
const PAYMENT_ID = '0192f1c4-0000-7000-8000-00000000f001';
const OTHER_STAFF_ID = '0192f1c4-0000-7000-8000-00000000d002';
const xof = (amount: number) => ({ amount, currency: 'XOF' });

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('portefeuille prépayé (cas d’usage, ADR-046)', () => {
  let setup: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;

  beforeEach(() => {
    setup = makeDeps();
    useCases = createUseCases(setup.deps);
    // payment confirme la recharge PAYMENT_ID du client (relue avant tout crédit, ADR-048).
    setup.topUps.record(PAYMENT_ID, USER_ID, 20000);
  });

  const topUp = (amount = 20000, overrides: Record<string, unknown> = {}) =>
    useCases.creditTopUp.execute({
      eventId: '0192f1c4-0000-7000-c000-000000000001',
      eventType: 'payment.intent.succeeded',
      paymentId: PAYMENT_ID,
      subjectId: USER_ID,
      customerId: USER_ID,
      organizationId: null,
      amount,
      ...overrides,
    });

  const debit = (overrides: Record<string, unknown> = {}, caller = 'cleaning') =>
    asServiceFor(caller, USER_ID, () =>
      useCases.debitPrepaid.execute({
        idempotencyKey: `${MISSION_ID}:deposit:key-0001`,
        holder: USER,
        amount: xof(15000),
        object: { objectType: 'cleaning_mission', objectId: MISSION_ID, part: 'deposit' },
        description: 'Nettoyage de maison — acompte',
        ...overrides,
      } as never),
    );

  const prepaid = (holder = USER) => setup.store.prepaidSummary(holder as never);

  describe('recharge', () => {
    it('montant entre les limites ; paiement créé chez payment pour le titulaire du connecté', async () => {
      const result = await asCustomer(() =>
        useCases.createTopUp.execute({ idempotencyKey: 'topup-key-0001', amount: xof(5000) }),
      );
      expect(result).toMatchObject({
        created: true,
        topUp: { holder: USER, amount: 5000, status: 'pending', checkoutUrl: expect.any(String) },
      });
      for (const amount of [499, 1_000_001]) {
        const error = await rejection(
          asCustomer(() =>
            useCases.createTopUp.execute({ idempotencyKey: 'topup-key-0002', amount: xof(amount) }),
          ),
        );
        expect(error).toMatchObject({ code: 'WALLET_VALIDATION_FAILED', details: { field: 'amount' } });
      }
      expect(setup.topUps.requests).toHaveLength(1);
    });

    it('organisation : membre org_member autorisé, lecteur refusé', async () => {
      const member = await asCustomer(
        () => useCases.createTopUp.execute({ idempotencyKey: 'topup-key-0003', amount: xof(5000) }),
        ORGANIZATION_ID,
        'org_member',
      );
      expect(member.topUp.holder).toEqual(ORG);
      const viewer = await rejection(
        asCustomer(
          () => useCases.createTopUp.execute({ idempotencyKey: 'topup-key-0004', amount: xof(5000) }),
          ORGANIZATION_ID,
          'org_viewer',
        ),
      );
      expect(viewer.code).toBe('AUTH_FORBIDDEN');
    });

    it('relue chez payment avant le crédit : non réussie, autre titulaire ou autre montant reçu → rien (ADR-048)', async () => {
      setup.topUps.record(PAYMENT_ID, USER_ID, 20000, { status: 'pending', receivedAmount: null });
      expect(await topUp()).toBe('rejected');
      setup.topUps.record(PAYMENT_ID, ORGANIZATION_ID, 20000, { organizationId: ORGANIZATION_ID });
      expect(await topUp()).toBe('rejected');
      setup.topUps.record(PAYMENT_ID, USER_ID, 20000, { receivedAmount: 15000 });
      expect(await topUp()).toBe('rejected');
      setup.topUps.records.delete(PAYMENT_ID);
      expect(await topUp()).toBe('rejected');
      expect((await prepaid()).balance).toBe(0);
      // payment injoignable : erreur, l'événement sera réessayé.
      setup.topUps.record(PAYMENT_ID, USER_ID, 20000);
      setup.topUps.down = true;
      expect((await rejection(topUp())).code).toBe('GRPC_UNAVAILABLE');
      setup.topUps.down = false;
      expect(await topUp()).toBe('recorded');
      expect((await prepaid()).balance).toBe(20000);
    });

    it('confirmation : créditée une seule fois, titulaire incohérent ignoré, événement publié', async () => {
      expect(await topUp()).toBe('recorded');
      expect(await topUp()).toBe('duplicate');
      expect(await topUp(20000, { eventId: '0192f1c4-0000-7000-c000-000000000002' })).toBe('duplicate');
      expect(await topUp(20000, { subjectId: ORGANIZATION_ID, paymentId: MISSION_ID })).toBe('ignored');
      expect((await prepaid()).balance).toBe(20000);
      expect(setup.store.events).toEqual([
        {
          type: 'wallet.prepaid.credited',
          payload: expect.objectContaining({
            kind: 'top_up',
            origin: 'payment',
            userId: USER_ID,
            paymentId: PAYMENT_ID,
            balanceAfter: xof(20000),
          }),
        },
      ]);
    });
  });

  describe('débit par un service', () => {
    it('débite, publie l’événement ; rejeu de la même clé sans second débit', async () => {
      await topUp();
      const first = await debit();
      expect(first).toMatchObject({ created: true, wallet: { balance: 5000 } });
      expect(first.transaction).toMatchObject({
        kind: 'service_payment',
        caller: 'cleaning',
        actorId: USER_ID,
        object: { type: 'cleaning_mission', id: MISSION_ID, part: 'deposit' },
      });
      const again = await debit();
      expect(again).toMatchObject({ created: false, transaction: { id: first.transaction.id } });
      expect((await prepaid()).balance).toBe(5000);
      expect(setup.store.events.at(-1)).toMatchObject({
        type: 'wallet.prepaid.debited',
        payload: { service: 'cleaning', part: 'deposit', balanceAfter: xof(5000), userId: USER_ID },
      });
    });

    it('jamais partiel : solde insuffisant refusé avec le montant manquant, rien n’est écrit', async () => {
      setup.topUps.record(PAYMENT_ID, USER_ID, 10000);
      await topUp(10000);
      const error = await rejection(debit());
      expect(error).toMatchObject({
        code: 'WALLET_INSUFFICIENT_FUNDS',
        details: { balance: xof(10000), missing: xof(5000) },
      });
      expect(error.message).toContain('5');
      expect((await prepaid()).balance).toBe(10000);
    });

    it('même clé pour un autre débit refusée ; service non autorisé refusé', async () => {
      await topUp();
      await debit();
      expect((await rejection(debit({ amount: xof(1000) }))).code).toBe('WALLET_IDEMPOTENCY_KEY_REUSED');
      expect((await rejection(debit({ idempotencyKey: 'other-key-0001' }, 'recovery'))).code).toBe(
        'WALLET_CALLER_FORBIDDEN',
      );
    });

    it('remboursement : une seule fois, par le service qui a débité ; rejeu du débit remboursé refusé', async () => {
      await topUp();
      const { transaction } = await debit();
      expect(
        (
          await rejection(
            asService('billing', () =>
              useCases.refundDebit.execute({ transactionId: transaction.id, reason: 'annulée' }),
            ),
          )
        ).code,
      ).toBe('WALLET_TRANSACTION_NOT_FOUND');
      const refund = () =>
        asService('cleaning', () =>
          useCases.refundDebit.execute({ transactionId: transaction.id, reason: 'mission annulée' }),
        );
      const first = await refund();
      expect(first).toMatchObject({ created: true, wallet: { balance: 20000 } });
      expect(first.transaction.description).toBe(
        'Remboursement — Nettoyage de maison — acompte (mission annulée)',
      );
      expect(await refund()).toMatchObject({ created: false, transaction: { id: first.transaction.id } });
      expect(
        await useCases.refundFromEvent.execute({
          producer: 'cleaning',
          transactionIds: [transaction.id],
          reason: 'mission annulée',
        }),
      ).toEqual({ refunded: 0, already: 1 });
      expect((await rejection(debit())).code).toBe('WALLET_DEBIT_REFUNDED');
      expect(setup.store.events.at(-1)).toMatchObject({
        type: 'wallet.prepaid.credited',
        payload: { kind: 'refund', origin: 'service', refundedTransactionId: transaction.id },
      });
    });

    it('événement d’un émetteur non autorisé ignoré', async () => {
      expect(
        await useCases.refundFromEvent.execute({
          producer: 'recovery',
          transactionIds: [MISSION_ID],
          reason: 'x',
        }),
      ).toBe('ignored');
    });
  });

  describe('crédit au prorata d’une mission arrêtée (cleaning.mission.credited, ADR-049)', () => {
    const CREDIT_ID = '0192f1c4-0000-7000-8000-00000000e101';
    const credited = (overrides: Record<string, unknown> = {}) =>
      useCases.creditFromMission.execute({
        eventId: '0192f1c4-0000-7000-c000-000000000101',
        eventType: 'cleaning.mission.credited',
        producer: 'cleaning',
        missionId: MISSION_ID,
        customerId: USER_ID,
        creditId: CREDIT_ID,
        amount: 30000,
        ...overrides,
      });

    it('crédité une seule fois par creditId, au portefeuille du client, événement publié', async () => {
      expect(await credited()).toBe('recorded');
      expect(await credited()).toBe('duplicate');
      expect(await credited({ eventId: '0192f1c4-0000-7000-c000-000000000102' })).toBe('duplicate');
      expect((await prepaid()).balance).toBe(30000);
      const [transaction] = [...setup.store.transactions.values()];
      expect(transaction).toMatchObject({
        kind: 'refund',
        caller: 'cleaning',
        amount: 30000,
        object: { type: 'cleaning_mission', id: MISSION_ID, part: null },
      });
      expect(setup.store.events).toEqual([
        {
          type: 'wallet.prepaid.credited',
          payload: expect.objectContaining({
            kind: 'refund',
            origin: 'service',
            userId: USER_ID,
            amount: xof(30000),
          }),
        },
      ]);
    });

    it('émetteur autre que cleaning, ou montant invalide : rien', async () => {
      expect(await credited({ producer: 'billing' })).toBe('ignored');
      expect((await rejection(credited({ amount: 0 }))).code).toBe('WALLET_VALIDATION_FAILED');
      expect((await prepaid()).balance).toBe(0);
    });
  });

  describe('crédit manuel de la finance', () => {
    const credit = (
      overrides: Record<string, unknown> = {},
      role = 'finance_officer',
      mfa = true,
      userId = STAFF_ID,
    ) =>
      asStaff(
        () =>
          useCases.creditPrepaidWallet.execute({
            idempotencyKey: 'credit-key-0001',
            holder: ORG,
            kind: 'refund',
            amount: xof(3000),
            reason: 'Passage du 3 novembre non effectué',
            paymentId: '',
            ...overrides,
          } as never),
        role,
        mfa,
        userId,
      );

    it('remboursement avec motif et auteur ; rejouable ; finance avec double authentification', async () => {
      expect((await rejection(credit({}, 'cleaning_admin'))).code).toBe('AUTH_FORBIDDEN');
      expect((await rejection(credit({}, 'finance_officer', false))).code).toBe('AUTH_MFA_REQUIRED');
      const first = await credit();
      expect(first).toMatchObject({
        created: true,
        transaction: { kind: 'refund', actorId: STAFF_ID, description: 'Passage du 3 novembre non effectué' },
        wallet: { balance: 3000 },
      });
      expect(await credit()).toMatchObject({ created: false });
      expect((await rejection(credit({ amount: xof(10) }))).code).toBe('WALLET_IDEMPOTENCY_KEY_REUSED');
      // Organisation sans destinataire désigné : la notification n'est envoyée à personne.
      expect(setup.store.events.at(-1)).toMatchObject({ payload: { origin: 'finance', userId: null } });
    });

    it('recharge non créditée (écart traité) : une seule fois par paiement, même après le crédit automatique', async () => {
      setup.topUps.record(PAYMENT_ID, USER_ID, 5000, { status: 'amount_mismatch', receivedAmount: 4900 });
      const manual = await credit({ kind: 'top_up', holder: USER, paymentId: PAYMENT_ID, amount: xof(4900) });
      expect(manual.transaction?.kind).toBe('top_up');
      expect(await topUp(4900)).toBe('duplicate');
      expect(
        (await rejection(credit({ kind: 'top_up', holder: USER, paymentId: PAYMENT_ID, amount: xof(5000) })))
          .code,
      ).toBe('WALLET_IDEMPOTENCY_KEY_REUSED');
      expect((await rejection(credit({ kind: 'top_up', holder: USER }))).code).toBe(
        'WALLET_VALIDATION_FAILED',
      );
      expect((await prepaid()).balance).toBe(4900);
    });
  });

  describe('crédit manuel contrôlé (ADR-048)', () => {
    const credit = (overrides: Record<string, unknown> = {}, userId = STAFF_ID) =>
      asStaff(
        () =>
          useCases.creditPrepaidWallet.execute({
            idempotencyKey: 'credit-key-0101',
            holder: USER,
            kind: 'refund',
            amount: xof(3000),
            reason: 'Passage du 3 novembre non effectué',
            paymentId: '',
            ...overrides,
          } as never),
        'finance_officer',
        true,
        userId,
      );
    const approve = (requestId: string, userId = OTHER_STAFF_ID) =>
      asStaff(() => useCases.approveManualCredit.execute(requestId), 'finance_officer', true, userId);
    const topUpCredit = (amount: number, holder = USER) =>
      credit({ kind: 'top_up', holder, paymentId: PAYMENT_ID, amount: xof(amount) });

    it('recharge : confirmée par payment, du même titulaire, jamais au-delà du montant reçu', async () => {
      const reasonOf = async (promise: Promise<unknown>) => {
        const error = await rejection(promise);
        expect(error.code).toBe('WALLET_TOP_UP_NOT_VERIFIED');
        return error.details['reason'];
      };
      setup.topUps.records.delete(PAYMENT_ID);
      expect(await reasonOf(topUpCredit(4900))).toBe('payment_not_found');
      setup.topUps.record(PAYMENT_ID, USER_ID, 5000, { status: 'pending', receivedAmount: null });
      expect(await reasonOf(topUpCredit(4900))).toBe('not_received');
      setup.topUps.record(PAYMENT_ID, USER_ID, 5000, { status: 'amount_mismatch', receivedAmount: 4900 });
      expect(await reasonOf(topUpCredit(4900, ORG))).toBe('other_holder');
      expect(await reasonOf(topUpCredit(5000))).toBe('exceeds_received');
      expect(await topUpCredit(4900)).toMatchObject({ created: true, transaction: { kind: 'top_up' } });
    });

    it('remboursement : plafonné et justifié', async () => {
      expect((await rejection(credit({ amount: xof(100_001) }))).code).toBe('WALLET_CREDIT_LIMIT_EXCEEDED');
      expect((await rejection(credit({ reason: 'geste' }))).code).toBe('WALLET_VALIDATION_FAILED');
      expect(await credit()).toMatchObject({ created: true, pendingRequest: null });
    });

    it('au-delà du seuil : rien n’est écrit avant la validation d’un second membre de la finance', async () => {
      const first = await credit({ amount: xof(60_000) });
      expect(first).toMatchObject({
        created: true,
        transaction: null,
        pendingRequest: { status: 'pending_approval', requestedBy: STAFF_ID, amount: 60_000 },
      });
      expect((await prepaid()).balance).toBe(0);
      // Rejeu de la même demande : la même demande ; autre montant avec la même clé : refusé.
      expect(await credit({ amount: xof(60_000) })).toMatchObject({
        created: false,
        pendingRequest: { id: first.pendingRequest!.id },
      });
      expect((await rejection(credit({ amount: xof(70_000) }))).code).toBe('WALLET_IDEMPOTENCY_KEY_REUSED');
      // L'auteur ne valide pas sa propre demande.
      expect((await rejection(approve(first.pendingRequest!.id, STAFF_ID))).code).toBe(
        'WALLET_APPROVAL_BY_REQUESTER',
      );
      const approved = await approve(first.pendingRequest!.id);
      expect(approved).toMatchObject({
        created: true,
        transaction: { kind: 'refund', amount: 60_000, actorId: STAFF_ID },
        request: { status: 'approved', approvedBy: OTHER_STAFF_ID },
        wallet: { balance: 60_000 },
      });
      // Validation rejouée : le même crédit ; la demande rejouée rend le crédit.
      expect(await approve(first.pendingRequest!.id)).toMatchObject({
        created: false,
        transaction: { id: approved.transaction.id },
      });
      expect(await credit({ amount: xof(60_000) })).toMatchObject({
        created: false,
        transaction: { id: approved.transaction.id },
        pendingRequest: null,
      });
      expect((await prepaid()).balance).toBe(60_000);
      const pending = await asStaff(() =>
        useCases.listManualCreditRequests.execute({ page: { limit: 20, cursor: null }, status: 'approved' }),
      );
      expect(pending.items.map((r) => r.id)).toEqual([first.pendingRequest!.id]);
    });

    it('double authentification de moins de 10 minutes pour créditer ou valider', async () => {
      const error = await rejection(
        runWithContext(
          {
            correlationId: 'c-test',
            user: {
              userId: STAFF_ID,
              sessionId: 's-test',
              activeContext: 'personal',
              roles: [{ role: 'finance_officer', scopeType: 'global' }],
              mfa: true,
              authTime: Math.floor(Date.now() / 1000) - 3600,
            },
          },
          () =>
            useCases.creditPrepaidWallet.execute({
              idempotencyKey: 'credit-key-0102',
              holder: USER,
              kind: 'refund',
              amount: xof(3000),
              reason: 'Passage du 3 novembre non effectué',
              paymentId: '',
            } as never),
        ),
      );
      expect(error.code).toBe('AUTH_MFA_REQUIRED');
    });
  });

  describe('lecture', () => {
    it('relevé des deux comptes, filtrable ; solde prépayé et limites de recharge', async () => {
      await topUp();
      await debit();
      const all = await asCustomer(() =>
        useCases.listMyStatement.execute({ page: { limit: 10, cursor: null }, account: '' }),
      );
      expect(
        all.items.map((line) => [line.account, line.transaction.kind, line.direction, line.balanceAfter]),
      ).toEqual([
        ['prepaid', 'service_payment', 'debit', 5000],
        ['prepaid', 'top_up', 'credit', 20000],
      ]);
      const collections = await asCustomer(() =>
        useCases.listMyStatement.execute({ page: { limit: 10, cursor: null }, account: 'collections' }),
      );
      expect(collections.items).toEqual([]);
      expect(
        (
          await rejection(
            asCustomer(() =>
              useCases.listMyStatement.execute({ page: { limit: 10, cursor: null }, account: 'x' }),
            ),
          )
        ).code,
      ).toBe('WALLET_VALIDATION_FAILED');
      const mine = await asCustomer(() => useCases.getMyWallet.execute());
      expect(mine).toMatchObject({
        wallet: { balance: 0, prepaid: { balance: 5000 } },
        topUpLimits: { min: 500 },
      });
      expect(await asService('billing', () => useCases.getPrepaidBalance.execute(USER))).toMatchObject({
        balance: 5000,
      });
    });
  });
});
