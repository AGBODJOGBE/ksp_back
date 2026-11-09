import { type AppError } from '@ksp/platform';
import {
  asCustomer,
  asService,
  asStaff,
  type FakeExecutor,
  makeDeps,
  ORGANIZATION_ID,
  USER_ID,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const ORG = { type: 'organization', id: ORGANIZATION_ID };
const BENEFICIARY = { phone: '+2290197000045', operator: 'mtn', name: 'SARL Bénin Immo' };

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('portefeuille (cas d’usage, ADR-042)', () => {
  let setup: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  const store = () => setup.store;
  const executor = () => setup.deps.executor as FakeExecutor;

  beforeEach(() => {
    setup = makeDeps();
    useCases = createUseCases(setup.deps);
  });

  const collect = (overrides: Record<string, unknown> = {}, caller = 'recovery') =>
    asService(caller, () =>
      useCases.recordCollection.execute({
        holder: ORG,
        grossAmount: { amount: 25000, currency: 'XOF' },
        commissionRateBps: 1250,
        reference: 'payment:0192f1c4-0000-7000-8000-0000000p0001',
        description: 'Échéance 2 sur 6 - dossier REC-2026-000123',
        ...overrides,
      } as never),
    );

  const requestPayout = (overrides: Record<string, unknown> = {}) =>
    asService('recovery', () =>
      useCases.requestPayout.execute({
        idempotencyKey: 'payout-key-0001',
        holder: ORG,
        amount: { amount: 21875, currency: 'XOF' },
        beneficiary: BENEFICIARY,
        ...overrides,
      } as never),
    );

  const settle = (
    payoutId: string,
    outcome: 'completed' | 'failed',
    eventId = '0192f1c4-0000-7000-b000-000000000001',
  ) =>
    useCases.settlePayout.execute({
      eventId,
      eventType: `payment.payout.${outcome}`,
      outcome,
      paymentPayoutId: '0192f1c4-0000-7000-a000-000000000001',
      issuer: 'wallet',
      reference: payoutId,
      amount: 21875,
    });

  /** Invariant du grand livre : fonds détenus = dû aux titulaires + commission + en transit. */
  const expectInvariant = () => {
    const b = store().balances;
    const holders = [...b.entries()]
      .filter(([code]) => code.startsWith('holder:'))
      .reduce((s, [, v]) => s + v, 0);
    expect(b.get('ksp:collections') ?? 0).toBe(
      holders + (b.get('ksp:commission') ?? 0) + (b.get('ksp:payouts_in_transit') ?? 0),
    );
  };

  describe('encaissement', () => {
    it('net au titulaire, commission à KSP arrondie à l’entier inférieur, écritures équilibrées', async () => {
      const { transaction, wallet, created } = await collect({
        grossAmount: { amount: 25001, currency: 'XOF' },
      });
      expect(created).toBe(true);
      // 12,5 % de 25 001 = 3 125,125 → 3 125 ; le titulaire reçoit 21 876.
      expect(transaction).toMatchObject({
        kind: 'collection',
        amount: 21876,
        grossAmount: 25001,
        commission: 3125,
      });
      expect(transaction.entries).toEqual([
        { account: 'ksp:collections', direction: 'debit', amount: 25001 },
        { account: `holder:organization:${ORGANIZATION_ID}`, direction: 'credit', amount: 21876 },
        { account: 'ksp:commission', direction: 'credit', amount: 3125 },
      ]);
      expect(wallet).toMatchObject({ balance: 21876, totalCollected: 21876, payoutsInProgress: 0 });
      expectInvariant();
    });

    it('idempotent par référence ; référence réutilisée pour autre chose : 409', async () => {
      const first = await collect();
      const again = await collect();
      expect(again).toMatchObject({ created: false, transaction: { id: first.transaction.id } });
      expect(store().transactions.size).toBe(1);
      expect((await rejection(collect({ commissionRateBps: 1000 }))).code).toBe(
        'WALLET_IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('commission nulle : pas de ligne de commission', async () => {
      const { transaction } = await collect({ commissionRateBps: 0 });
      expect(transaction.entries.map((e) => e.account)).toEqual([
        'ksp:collections',
        `holder:organization:${ORGANIZATION_ID}`,
      ]);
    });

    it.each([
      ['holder.type', { holder: { type: 'creditor', id: ORGANIZATION_ID } }],
      ['grossAmount', { grossAmount: { amount: 99.5, currency: 'XOF' } }],
      ['commissionRateBps', { commissionRateBps: 10001 }],
      ['commissionRateBps', { commissionRateBps: 12.5 }],
      ['reference', { reference: 'avec espace' }],
      ['description', { description: '' }],
    ])('refuse un champ invalide (%s)', async (field, overrides) => {
      const error = await rejection(collect(overrides));
      expect(error.code).toBe('WALLET_VALIDATION_FAILED');
      expect(error.details).toEqual({ field });
    });

    it('réservé aux services autorisés', async () => {
      expect((await rejection(collect({}, 'cleaning'))).code).toBe('WALLET_CALLER_FORBIDDEN');
    });
  });

  describe('reversement', () => {
    beforeEach(async () => {
      await collect();
    });

    it('retenu sur le solde puis transmis à payment ; numéro complet effacé après transmission', async () => {
      const { payout, wallet, created } = await requestPayout();
      expect(created).toBe(true);
      expect(payout).toMatchObject({
        status: 'submitted',
        amount: 21875,
        beneficiaryPhone: null,
        beneficiaryName: null,
        beneficiaryPhoneMasked: '+229 •• •• 45',
      });
      expect(executor().requests[0]).toEqual({
        idempotencyKey: payout.id,
        reference: payout.id,
        amount: 21875,
        beneficiary: { phone: '+2290197000045', operator: 'mtn', name: 'SARL Bénin Immo' },
      });
      expect(wallet).toMatchObject({ balance: 0, payoutsInProgress: 21875 });
      expect(store().balances.get('ksp:payouts_in_transit')).toBe(21875);
      expectInvariant();
      // Rejeu de la clé : même reversement, rien de plus.
      expect((await requestPayout()).payout.id).toBe(payout.id);
      expect(executor().requests).toHaveLength(1);
    });

    it('jamais au-delà du solde disponible', async () => {
      const error = await rejection(requestPayout({ amount: { amount: 21876, currency: 'XOF' } }));
      expect(error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
      expect(error.details).toEqual({ balance: 21875 });
      expect(store().payoutRows.size).toBe(0);
    });

    it('payment injoignable : reste en attente de transmission, transmis par la tâche planifiée', async () => {
      executor().down = true;
      const { payout } = await requestPayout();
      expect(payout).toMatchObject({ status: 'pending_submission', beneficiaryPhone: '+2290197000045' });
      executor().down = false;
      expect(await useCases.submitPendingPayouts.execute()).toEqual({ examined: 1, submitted: 1, errors: 0 });
      expect(store().payoutRows.get(payout.id)!.status).toBe('submitted');
    });

    it('terminé : sorti des fonds détenus ; événement rejoué sans effet', async () => {
      const { payout } = await requestPayout();
      expect(await settle(payout.id, 'completed')).toBe('recorded');
      expect(await settle(payout.id, 'completed')).toBe('duplicate');
      expect(store().balances.get('ksp:payouts_in_transit')).toBe(0);
      expect(store().balances.get('ksp:collections')).toBe(3125);
      const wallet = await asCustomer(() => useCases.getMyWallet.execute(), ORGANIZATION_ID);
      expect(wallet).toMatchObject({ balance: 0, payoutsInProgress: 0, totalPaidOut: 21875 });
      expectInvariant();
    });

    it('en échec : montant rendu au titulaire', async () => {
      const { payout } = await requestPayout();
      expect(await settle(payout.id, 'failed')).toBe('recorded');
      const wallet = await asService('recovery', () => useCases.getBalance.execute(ORG));
      expect(wallet).toMatchObject({ balance: 21875, payoutsInProgress: 0, totalPaidOut: 0 });
      expectInvariant();
    });

    it('issue arrivée avant la transmission notée (réponse de payment perdue) : appliquée', async () => {
      executor().down = true;
      const { payout } = await requestPayout();
      expect(await settle(payout.id, 'completed')).toBe('recorded');
      executor().down = false;
      await useCases.submitPendingPayouts.execute();
      expect(executor().requests).toHaveLength(0);
      expect(store().payoutRows.get(payout.id)!.status).toBe('completed');
    });

    it('événement d’un autre émetteur ou d’un reversement inconnu : ignoré', async () => {
      const { payout } = await requestPayout();
      const other = await useCases.settlePayout.execute({
        eventId: '0192f1c4-0000-7000-b000-000000000009',
        eventType: 'payment.payout.completed',
        outcome: 'completed',
        paymentPayoutId: 'x',
        issuer: 'realestate',
        reference: payout.id,
        amount: 21875,
      });
      expect(other).toBe('ignored');
      expect(await settle('0192f1c4-0000-7000-8000-000000009999', 'completed')).toBe('ignored');
    });
  });

  describe('annulation d’un encaissement', () => {
    it('écriture inverse, commission rendue ; une seule annulation, rejouable par sa référence', async () => {
      const { transaction } = await collect();
      const reverse = (reference = 'reversal:0001') =>
        asService('recovery', () =>
          useCases.reverseTransaction.execute({
            transactionId: transaction.id,
            reason: 'Encaissé à tort',
            reference,
          }),
        );
      const { transaction: reversal, wallet } = await reverse();
      expect(reversal.entries).toEqual([
        { account: 'ksp:collections', direction: 'credit', amount: 25000 },
        { account: `holder:organization:${ORGANIZATION_ID}`, direction: 'debit', amount: 21875 },
        { account: 'ksp:commission', direction: 'debit', amount: 3125 },
      ]);
      expect(wallet).toMatchObject({ balance: 0, totalCollected: 0 });
      expect((await reverse()).created).toBe(false);
      expect((await rejection(reverse('reversal:0002'))).code).toBe('WALLET_TRANSACTION_ALREADY_REVERSED');
      expectInvariant();
    });

    it('après un reversement : solde négatif (dette du titulaire), plus aucun reversement possible', async () => {
      const { transaction } = await collect();
      const { payout } = await requestPayout();
      await settle(payout.id, 'completed');
      await asService('recovery', () =>
        useCases.reverseTransaction.execute({
          transactionId: transaction.id,
          reason: 'Remboursé',
          reference: 'rev:1',
        }),
      );
      const wallet = await asService('recovery', () => useCases.getBalance.execute(ORG));
      expect(wallet.balance).toBe(-21875);
      const error = await rejection(
        requestPayout({ idempotencyKey: 'payout-key-0002', amount: { amount: 1, currency: 'XOF' } }),
      );
      expect(error.code).toBe('WALLET_INSUFFICIENT_BALANCE');
      expectInvariant();
    });

    it('seul un encaissement s’annule', async () => {
      await collect();
      const { payout } = await requestPayout();
      const error = await rejection(
        asService('recovery', () =>
          useCases.reverseTransaction.execute({
            transactionId: payout.holdTransactionId,
            reason: 'x',
            reference: 'r:1',
          }),
        ),
      );
      expect(error.code).toBe('WALLET_TRANSACTION_NOT_REVERSIBLE');
    });
  });

  describe('lecture', () => {
    it('relevé du titulaire connecté (organisation active), les plus récents d’abord', async () => {
      await collect();
      await collect({ reference: 'payment:2', grossAmount: { amount: 10000, currency: 'XOF' } });
      const { payout } = await requestPayout();
      const page = await asCustomer(
        () => useCases.listMyStatement.execute({ limit: 2, cursor: null }),
        ORGANIZATION_ID,
      );
      expect(
        page.items.map((line) => [line.transaction.kind, line.direction, line.amount, line.balanceAfter]),
      ).toEqual([
        ['payout_hold', 'debit', 21875, 8750],
        ['collection', 'credit', 8750, 30625],
      ]);
      expect(page.items[0]!.payoutStatus).toBe('submitted');
      const next = await asCustomer(
        () => useCases.listMyStatement.execute({ limit: 2, cursor: page.nextCursor }),
        ORGANIZATION_ID,
      );
      expect(next.items).toHaveLength(1);
      // Contexte personnel : un autre titulaire (le compte), vide.
      expect((await asCustomer(() => useCases.getMyWallet.execute())).holder).toEqual({
        type: 'user',
        id: USER_ID,
      });
      const payouts = await asCustomer(
        () => useCases.listMyPayouts.execute({ page: { limit: 20, cursor: null }, status: '' }),
        ORGANIZATION_ID,
      );
      expect(payouts.items.map((p) => p.id)).toEqual([payout.id]);
    });

    it('back-office : finance avec double authentification ; vue d’ensemble équilibrée', async () => {
      await collect();
      expect(
        (await rejection(asStaff(() => useCases.getLedgerOverview.execute(), 'cleaning_admin'))).code,
      ).toBe('AUTH_FORBIDDEN');
      expect(
        (await rejection(asStaff(() => useCases.getLedgerOverview.execute(), 'finance_officer', false))).code,
      ).toBe('AUTH_MFA_REQUIRED');
      const overview = await asStaff(() => useCases.getLedgerOverview.execute());
      expect(overview).toEqual({
        internal: [
          { account: 'ksp:collections', balance: 25000 },
          { account: 'ksp:commission', balance: 3125 },
          { account: 'ksp:payouts_in_transit', balance: 0 },
        ],
        owedToHolders: 21875,
        holdersCount: 1,
      });
      const wallet = await asStaff(() => useCases.getHolderWallet.execute(ORG));
      expect(wallet.balance).toBe(21875);
    });
  });
});
