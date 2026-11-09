import { type AppError } from '@ksp/platform';
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

  describe('crédit manuel de la finance', () => {
    const credit = (overrides: Record<string, unknown> = {}, role = 'finance_officer', mfa = true) =>
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
      const manual = await credit({ kind: 'top_up', holder: USER, paymentId: PAYMENT_ID, amount: xof(4900) });
      expect(manual.transaction.kind).toBe('top_up');
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
