import {
  balanceDelta,
  collectionEntries,
  commissionOf,
  isBalanced,
  payoutHoldEntries,
  payoutReleaseEntries,
  payoutSettlementEntries,
  reversalEntries,
} from './ledger';
import { markSubmitted, maskPhone, settle, type WalletPayout } from './wallet-payout';

const HOLDER = { type: 'organization' as const, id: 'o1' };

describe('grand livre (ADR-042)', () => {
  it('commission arrondie à l’entier inférieur, calcul exact sur les grands montants', () => {
    expect(commissionOf(25001, 1250)).toBe(3125);
    expect(commissionOf(1, 9999)).toBe(0);
    expect(commissionOf(1_000_000_000, 10_000)).toBe(1_000_000_000);
    expect(commissionOf(999_999_999, 333)).toBe(33_299_999);
  });

  it('chaque opération est équilibrée', () => {
    for (const entries of [
      collectionEntries(HOLDER, 25000, 1250).entries,
      collectionEntries(HOLDER, 25000, 10_000).entries,
      payoutHoldEntries(HOLDER, 100),
      payoutSettlementEntries(100),
      payoutReleaseEntries(HOLDER, 100),
      reversalEntries({ entries: collectionEntries(HOLDER, 25000, 1250).entries }),
    ]) {
      expect(isBalanced(entries)).toBe(true);
    }
    expect(isBalanced([{ account: 'ksp:commission', direction: 'credit', amount: 1 }])).toBe(false);
    expect(
      isBalanced([
        { account: 'ksp:collections', direction: 'debit', amount: 2 },
        { account: 'ksp:commission', direction: 'credit', amount: 1 },
      ]),
    ).toBe(false);
    expect(
      isBalanced([
        { account: 'ksp:collections', direction: 'debit', amount: 1.5 },
        { account: 'ksp:commission', direction: 'credit', amount: 1.5 },
      ]),
    ).toBe(false);
  });

  it('soldes dans le sens naturel : fonds détenus au débit, dettes et commission au crédit', () => {
    expect(balanceDelta({ account: 'ksp:collections', direction: 'debit', amount: 5 })).toBe(5);
    expect(balanceDelta({ account: 'holder:user:u1', direction: 'debit', amount: 5 })).toBe(-5);
    expect(balanceDelta({ account: 'ksp:commission', direction: 'credit', amount: 5 })).toBe(5);
  });
});

describe('reversement wallet', () => {
  const payout: WalletPayout = {
    id: 'p1',
    caller: 'recovery',
    idempotencyKey: 'k',
    holder: HOLDER,
    amount: 100,
    status: 'pending_submission',
    beneficiaryPhone: '+2290197000045',
    beneficiaryName: 'X',
    beneficiaryPhoneMasked: maskPhone('+2290197000045'),
    beneficiaryOperator: 'moov',
    paymentPayoutId: null,
    holdTransactionId: 't1',
    settlementTransactionId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    submittedAt: null,
    completedAt: null,
    failedAt: null,
    version: 0,
  };

  it('transmis : numéro et nom effacés ; soldé une seule fois', () => {
    const submitted = markSubmitted(payout, 'pp1', new Date(1))!;
    expect(submitted).toMatchObject({ status: 'submitted', beneficiaryPhone: null, beneficiaryName: null });
    expect(markSubmitted(submitted, 'pp1', new Date(2))).toBeNull();
    const done = settle(submitted, {
      outcome: 'completed',
      paymentPayoutId: 'pp1',
      settlementTransactionId: 't2',
      now: new Date(3),
    })!;
    expect(done).toMatchObject({ status: 'completed', completedAt: new Date(3) });
    expect(
      settle(done, {
        outcome: 'failed',
        paymentPayoutId: 'pp1',
        settlementTransactionId: 't3',
        now: new Date(4),
      }),
    ).toBeNull();
    expect(maskPhone('+2290197000045')).toBe('+229 •• •• 45');
  });
});
