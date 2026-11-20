import {
  accountOf,
  balanceDelta,
  isBalanced,
  serviceCreditEntries,
  withdrawalHoldEntries,
  withdrawalReleaseEntries,
  withdrawalSettlementEntries,
} from './ledger';
import {
  approveWithdrawal,
  markWithdrawalSubmitted,
  processWithdrawal,
  rejectWithdrawal,
  settleWithdrawal,
  type Withdrawal,
  withdrawalPayoutReference,
  withdrawalIdFromReference,
} from './withdrawal';

const HOLDER = { type: 'user' as const, id: 'u1' };
const FINANCE_A = 'f-a';
const FINANCE_B = 'f-b';

const requested: Withdrawal = {
  id: '0192f1c4-0000-7000-8000-0000000e0001',
  idempotencyKey: 'withdraw-0001',
  holder: HOLDER,
  amount: 5000,
  status: 'requested',
  beneficiaryPhone: '+2290197000045',
  beneficiaryName: 'Awa',
  beneficiaryPhoneMasked: '+229 •• •• 45',
  beneficiaryPhoneHash: 'h',
  beneficiaryOperator: 'mtn',
  requestedBy: 'u1',
  requestedAt: new Date(0),
  processedBy: null,
  processedAt: null,
  processingNote: null,
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  paymentPayoutId: null,
  holdTransactionId: 't-hold',
  settlementTransactionId: null,
  completedAt: null,
  failedAt: null,
  updatedAt: new Date(0),
  version: 0,
};

describe('écritures v2 du portefeuille prépayé', () => {
  it('crédit d’un service, retenue, sortie et restitution d’un retrait : équilibrés', () => {
    for (const entries of [
      serviceCreditEntries(HOLDER, 100),
      withdrawalHoldEntries(HOLDER, 100),
      withdrawalSettlementEntries(100),
      withdrawalReleaseEntries(HOLDER, 100),
    ]) {
      expect(isBalanced(entries)).toBe(true);
    }
  });

  it('retenue : le portefeuille baisse, le montant passe en transit ; sortie : il quitte les fonds', () => {
    const hold = withdrawalHoldEntries(HOLDER, 100);
    expect(hold.map((line) => [line.account, balanceDelta(line)])).toEqual([
      ['prepaid:user:u1', -100],
      ['ksp:prepaid_withdrawals_in_transit', 100],
    ]);
    const out = withdrawalSettlementEntries(100);
    expect(out.map((line) => [line.account, balanceDelta(line)])).toEqual([
      ['ksp:prepaid_withdrawals_in_transit', -100],
      ['ksp:prepaid_funds', -100],
    ]);
    expect(serviceCreditEntries(HOLDER, 100).map((line) => [line.account, balanceDelta(line)])).toEqual([
      ['prepaid:user:u1', 100],
      ['ksp:service_revenue', -100],
    ]);
  });

  it('les écritures v2 touchent le portefeuille prépayé du titulaire', () => {
    for (const kind of [
      'service_credit',
      'withdrawal_hold',
      'withdrawal_settlement',
      'withdrawal_release',
    ] as const) {
      expect(accountOf({ kind, holder: HOLDER })).toBe('prepaid:user:u1');
    }
  });
});

describe('retrait vers Mobile Money (R-WL-04)', () => {
  it('traité, validé par une autre personne, transmis puis terminé', () => {
    const processed = processWithdrawal(requested, {
      staffId: FINANCE_A,
      note: 'Numéro vérifié',
      now: new Date(1),
    })!;
    expect(processed).toMatchObject({ status: 'awaiting_approval', processedBy: FINANCE_A });
    expect(processWithdrawal(processed, { staffId: FINANCE_A, note: 'x', now: new Date(2) })).toBeNull();

    expect(approveWithdrawal(processed, { staffId: FINANCE_A, now: new Date(2) })).toBeNull();
    const approved = approveWithdrawal(processed, { staffId: FINANCE_B, now: new Date(2) })!;
    expect(approved).toMatchObject({ status: 'awaiting_approval', approvedBy: FINANCE_B });
    expect(approveWithdrawal(approved, { staffId: FINANCE_B, now: new Date(3) })).toBeNull();

    const submitted = markWithdrawalSubmitted(approved, 'pp1', new Date(3))!;
    expect(submitted).toMatchObject({ status: 'submitted', beneficiaryPhone: null, beneficiaryName: null });
    expect(markWithdrawalSubmitted(submitted, 'pp1', new Date(4))).toBeNull();

    const done = settleWithdrawal(submitted, {
      outcome: 'completed',
      paymentPayoutId: 'pp1',
      settlementTransactionId: 't-out',
      now: new Date(5),
    })!;
    expect(done).toMatchObject({
      status: 'completed',
      completedAt: new Date(5),
      settlementTransactionId: 't-out',
    });
    expect(
      settleWithdrawal(done, {
        outcome: 'failed',
        paymentPayoutId: 'pp1',
        settlementTransactionId: 'x',
        now: new Date(6),
      }),
    ).toBeNull();
  });

  it('issue reçue avant que la transmission soit notée : appliquée, numéro effacé', () => {
    const approved = approveWithdrawal(
      processWithdrawal(requested, { staffId: FINANCE_A, note: 'ok', now: new Date(1) })!,
      { staffId: FINANCE_B, now: new Date(2) },
    )!;
    const failed = settleWithdrawal(approved, {
      outcome: 'failed',
      paymentPayoutId: 'pp1',
      settlementTransactionId: 't-back',
      now: new Date(3),
    })!;
    expect(failed).toMatchObject({ status: 'failed', paymentPayoutId: 'pp1', beneficiaryPhone: null });
    // Un retrait ni validé ni transmis ne reçoit pas d'issue de payment.
    expect(
      settleWithdrawal(requested, {
        outcome: 'completed',
        paymentPayoutId: 'pp',
        settlementTransactionId: 't',
        now: new Date(3),
      }),
    ).toBeNull();
  });

  it('refus possible avant la validation seulement ; le montant est rendu', () => {
    const rejected = rejectWithdrawal(requested, {
      staffId: FINANCE_A,
      reason: 'Numéro au nom d’un tiers',
      settlementTransactionId: 't-back',
      now: new Date(1),
    })!;
    expect(rejected).toMatchObject({
      status: 'rejected',
      rejectedBy: FINANCE_A,
      settlementTransactionId: 't-back',
      beneficiaryPhone: null,
      beneficiaryName: null,
    });
    const processed = processWithdrawal(requested, { staffId: FINANCE_A, note: 'ok', now: new Date(1) })!;
    expect(
      rejectWithdrawal(processed, {
        staffId: FINANCE_B,
        reason: 'r',
        settlementTransactionId: 't',
        now: new Date(2),
      }),
    ).not.toBeNull();
    const approved = approveWithdrawal(processed, { staffId: FINANCE_B, now: new Date(2) })!;
    expect(
      rejectWithdrawal(approved, {
        staffId: FINANCE_A,
        reason: 'r',
        settlementTransactionId: 't',
        now: new Date(3),
      }),
    ).toBeNull();
    expect(
      rejectWithdrawal(rejected, {
        staffId: FINANCE_A,
        reason: 'r',
        settlementTransactionId: 't',
        now: new Date(3),
      }),
    ).toBeNull();
  });

  it('référence chez payment : « wallet_withdrawal:<id> », relue sans ambiguïté', () => {
    const reference = withdrawalPayoutReference(requested.id);
    expect(reference).toBe(`wallet_withdrawal:${requested.id}`);
    expect(withdrawalIdFromReference(reference)).toBe(requested.id);
    expect(withdrawalIdFromReference(requested.id)).toBeNull();
    expect(withdrawalIdFromReference('wallet_withdrawal:pas-un-uuid')).toBeNull();
  });
});
