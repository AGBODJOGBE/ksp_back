import { type AppError } from '@ksp/platform';
import {
  type FakeExecutor,
  asCustomer,
  asStaff,
  makeDeps,
  ORGANIZATION_ID,
  STAFF_ID,
  USER_ID,
} from './testing/fakes';
import { createUseCases } from './use-cases';

const USER = { type: 'user' as const, id: USER_ID };
const OTHER_STAFF_ID = '0192f1c4-0000-7000-8000-00000000d002';
const PAYMENT_ID = '0192f1c4-0000-7000-8000-00000000f301';
const xof = (amount: number) => ({ amount, currency: 'XOF' });
const BENEFICIARY = { phone: '+2290197000045', operator: 'mtn', name: 'Awa Dossou' };

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('rejet attendu');
}

describe('retrait du portefeuille vers Mobile Money (R-WL-04, ADR-055 décision 8)', () => {
  let setup: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;
  let executor: FakeExecutor;

  beforeEach(async () => {
    setup = makeDeps();
    useCases = createUseCases(setup.deps);
    executor = setup.deps.executor as FakeExecutor;
    setup.topUps.record(PAYMENT_ID, USER_ID, 20000);
    await useCases.creditTopUp.execute({
      eventId: '0192f1c4-0000-7000-c000-000000000301',
      eventType: 'payment.intent.succeeded',
      paymentId: PAYMENT_ID,
      subjectId: USER_ID,
      customerId: USER_ID,
      organizationId: null,
      amount: 20000,
    });
    setup.store.events.length = 0;
  });

  const request = (overrides: Record<string, unknown> = {}, organizationId?: string, orgRole?: string) =>
    asCustomer(
      () =>
        useCases.requestWithdrawal.execute({
          idempotencyKey: 'withdraw-key-0001',
          amount: xof(5000),
          beneficiary: BENEFICIARY,
          ...overrides,
        } as never),
      organizationId,
      orgRole,
    );
  const staff = <T>(fn: () => Promise<T>, userId = STAFF_ID) => asStaff(fn, 'finance_officer', true, userId);
  const process = (id: string, userId = STAFF_ID) =>
    staff(
      () => useCases.processWithdrawal.execute({ withdrawalId: id, note: 'Titulaire et numéro vérifiés' }),
      userId,
    );
  const approve = (id: string, userId = OTHER_STAFF_ID) =>
    staff(() => useCases.approveWithdrawal.execute({ withdrawalId: id }), userId);
  const reject = (id: string, userId = STAFF_ID) =>
    staff(
      () => useCases.rejectWithdrawal.execute({ withdrawalId: id, reason: 'Numéro au nom d’un tiers' }),
      userId,
    );

  it('demande : montant retenu aussitôt, numéro masqué ; idempotente par clé', async () => {
    const first = await request();
    expect(first).toMatchObject({
      created: true,
      withdrawal: {
        status: 'requested',
        amount: 5000,
        beneficiaryPhoneMasked: '+229 •• •• 45',
        requestedBy: USER_ID,
      },
      wallet: { balance: 15000, withdrawalsInProgress: 5000 },
    });
    expect(setup.store.balances.get('ksp:prepaid_withdrawals_in_transit')).toBe(5000);
    expect(await request()).toMatchObject({ created: false, withdrawal: { id: first.withdrawal.id } });
    expect((await rejection(request({ amount: xof(10) }))).code).toBe('WALLET_IDEMPOTENCY_KEY_REUSED');
    expect(
      (await rejection(request({ beneficiary: { ...BENEFICIARY, phone: '+2290197000046' } }))).code,
    ).toBe('WALLET_IDEMPOTENCY_KEY_REUSED');
    // Jamais au-delà du solde disponible.
    const error = await rejection(request({ idempotencyKey: 'withdraw-key-0002', amount: xof(15001) }));
    expect(error.code).toBe('WALLET_INSUFFICIENT_FUNDS');
    expect(setup.store.withdrawalRows.size).toBe(1);
  });

  it('organisation : administrateur seulement ; contrôles du bénéficiaire', async () => {
    expect((await rejection(request({}, ORGANIZATION_ID, 'org_member'))).code).toBe('AUTH_FORBIDDEN');
    expect((await rejection(request({}, ORGANIZATION_ID, 'org_admin'))).code).toBe(
      'WALLET_INSUFFICIENT_FUNDS',
    );
    const field = async (overrides: Record<string, unknown>) =>
      ((await rejection(request(overrides))).details as { field: string }).field;
    expect(await field({ idempotencyKey: 'court' })).toBe('idempotencyKey');
    expect(await field({ beneficiary: { ...BENEFICIARY, phone: '0197000045' } })).toBe('beneficiary.phone');
    expect(await field({ beneficiary: { ...BENEFICIARY, operator: 'orange' } })).toBe('beneficiary.operator');
    expect(await field({ beneficiary: { ...BENEFICIARY, name: '' } })).toBe('beneficiary.name');
  });

  it('traité puis validé par une deuxième personne : transmis à payment, terminé à son issue', async () => {
    const { withdrawal } = await request();
    const processed = await process(withdrawal.id);
    expect(processed.withdrawal).toMatchObject({ status: 'awaiting_approval', processedBy: STAFF_ID });
    expect((await rejection(approve(withdrawal.id, STAFF_ID))).code).toBe('WALLET_APPROVAL_BY_PROCESSOR');
    expect((await rejection(process(withdrawal.id))).code).toBe('WALLET_WITHDRAWAL_INVALID_TRANSITION');

    const approved = await approve(withdrawal.id);
    expect(approved.withdrawal).toMatchObject({
      status: 'submitted',
      approvedBy: OTHER_STAFF_ID,
      paymentPayoutId: expect.any(String),
    });
    expect(executor.requests).toEqual([
      {
        idempotencyKey: withdrawal.id,
        reference: `wallet_withdrawal:${withdrawal.id}`,
        amount: 5000,
        beneficiary: { phone: BENEFICIARY.phone, operator: 'mtn', name: 'Awa Dossou' },
      },
    ]);
    expect(setup.store.withdrawalRows.get(withdrawal.id)).toMatchObject({ beneficiaryPhone: null });
    // Validation rejouée : rien de plus n'est transmis.
    expect((await approve(withdrawal.id)).withdrawal.status).toBe('submitted');
    expect(executor.requests).toHaveLength(1);

    const settle = (outcome: 'completed' | 'failed', eventId: string) =>
      useCases.settlePayout.execute({
        eventId,
        eventType: `payment.payout.${outcome}`,
        outcome,
        paymentPayoutId: approved.withdrawal.paymentPayoutId!,
        issuer: 'wallet',
        reference: `wallet_withdrawal:${withdrawal.id}`,
        amount: 5000,
      });
    expect(await settle('completed', '0192f1c4-0000-7000-c000-000000000302')).toBe('recorded');
    expect(await settle('completed', '0192f1c4-0000-7000-c000-000000000303')).toBe('duplicate');
    expect(setup.store.withdrawalRows.get(withdrawal.id)).toMatchObject({ status: 'completed' });
    expect(setup.store.balances.get('ksp:prepaid_withdrawals_in_transit')).toBe(0);
    expect(setup.store.balances.get('ksp:prepaid_funds')).toBe(15000);
    expect((await setup.store.prepaidSummary(USER)).withdrawalsInProgress).toBe(0);
  });

  it('virement en échec : montant rendu au portefeuille', async () => {
    const { withdrawal } = await request();
    await process(withdrawal.id);
    const approved = await approve(withdrawal.id);
    const outcome = await useCases.settlePayout.execute({
      eventId: '0192f1c4-0000-7000-c000-000000000304',
      eventType: 'payment.payout.failed',
      outcome: 'failed',
      paymentPayoutId: approved.withdrawal.paymentPayoutId!,
      issuer: 'wallet',
      reference: `wallet_withdrawal:${withdrawal.id}`,
      amount: 5000,
    });
    expect(outcome).toBe('recorded');
    expect(await setup.store.prepaidSummary(USER)).toMatchObject({
      balance: 20000,
      withdrawalsInProgress: 0,
    });
  });

  it('payment injoignable à la validation : validation gardée, transmise au rejeu ; plus refusable', async () => {
    const { withdrawal } = await request();
    await process(withdrawal.id);
    executor.down = true;
    expect((await rejection(approve(withdrawal.id))).code).toBe('GRPC_UNAVAILABLE');
    expect(setup.store.withdrawalRows.get(withdrawal.id)).toMatchObject({
      status: 'awaiting_approval',
      approvedBy: OTHER_STAFF_ID,
    });
    expect((await rejection(reject(withdrawal.id))).code).toBe('WALLET_WITHDRAWAL_INVALID_TRANSITION');
    executor.down = false;
    expect((await approve(withdrawal.id)).withdrawal.status).toBe('submitted');
  });

  it('refus motivé avant validation : montant rendu ; listes du titulaire et de la finance', async () => {
    const { withdrawal } = await request();
    const rejected = await reject(withdrawal.id);
    expect(rejected).toMatchObject({
      withdrawal: { status: 'rejected', rejectionReason: 'Numéro au nom d’un tiers', beneficiaryPhone: null },
      wallet: { balance: 20000, withdrawalsInProgress: 0 },
    });
    expect((await rejection(reject(withdrawal.id))).code).toBe('WALLET_WITHDRAWAL_INVALID_TRANSITION');
    expect((await rejection(approve(withdrawal.id))).code).toBe('WALLET_WITHDRAWAL_INVALID_TRANSITION');
    expect((await rejection(process(PAYMENT_ID))).code).toBe('WALLET_WITHDRAWAL_NOT_FOUND');

    const second = await request({ idempotencyKey: 'withdraw-key-0002', amount: xof(1000) });
    const mine = await asCustomer(() =>
      useCases.listMyWithdrawals.execute({ page: { limit: 20, cursor: null }, status: '' }),
    );
    expect(mine.items.map((w) => w.id)).toEqual([second.withdrawal.id, withdrawal.id]);
    const pending = await staff(() =>
      useCases.listWithdrawals.execute({
        page: { limit: 20, cursor: null },
        status: 'requested',
        holder: undefined,
      }),
    );
    expect(pending.items.map((w) => w.id)).toEqual([second.withdrawal.id]);
    const all = await staff(() =>
      useCases.listWithdrawals.execute({ page: { limit: 20, cursor: null }, status: '', holder: USER }),
    );
    expect(all.items.map((w) => w.id)).toEqual([withdrawal.id, second.withdrawal.id]);
    // Autre titulaire : introuvable pour le client ; finance seulement pour le back-office.
    expect(
      (
        await rejection(
          asCustomer(() =>
            useCases.listWithdrawals.execute({
              page: { limit: 20, cursor: null },
              status: '',
              holder: undefined,
            }),
          ),
        )
      ).code,
    ).toBe('AUTH_FORBIDDEN');
  });
});
