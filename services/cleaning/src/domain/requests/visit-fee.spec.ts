/**
 * Frais de visite (partie 7.2).
 *
 * Matrice règle → test :
 * - R-FV-01 montant par catégorie, défaut, majoration communale → « montant (R-FV-01) »
 * - R-FV-02 paiement, la demande passe « visite à planifier »   → « paiement (R-FV-02, R-FV-03) »
 * - R-FV-03 échéance de 72 h, borne exacte                       → « paiement (R-FV-02, R-FV-03) »
 * - R-FV-05 déduction du premier paiement, report sur la suite   → « déduction (R-FV-05) »
 * - R-FV-06 remboursement garanti, jamais deux fois              → « remboursement (R-FV-06) »
 * - R-FV-06 visite suivante gratuite après annulation par KSP    → « frais qui couvrent la visite »
 * - R-VI-05 / RV-48 nouveaux frais après absence (rang + 1)      → « nouveaux frais (R-VI-05) »
 */
import { DomainRuleError } from './errors';
import {
  allocateVisitFeeDeduction,
  deductibleVisitFeeAmount,
  feeCoveringNextVisit,
  newVisitFee,
  nextVisitFeeRank,
  payVisitFee,
  refundVisitFee,
  retainVisitFee,
  settleVisitFeesOnAcceptance,
  type VisitFee,
  visitFeeAmount,
} from './visit-fee';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-20T09:00:00Z');

function thrown(fn: () => unknown): DomainRuleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainRuleError) return error;
    throw error;
  }
  throw new Error('aucune erreur levée');
}

function fee(overrides: Partial<VisitFee> = {}): VisitFee {
  return {
    id: 'fee-1',
    rank: 1,
    amount: 5_000,
    status: 'paid',
    dueAt: null,
    paidAt: NOW,
    refundedAt: null,
    ...overrides,
  };
}

describe('montant (R-FV-01)', () => {
  it('frais de la catégorie, majorés du montant fixe de la commune', () => {
    expect(visitFeeAmount({ categoryFee: 5_000, defaultFee: 4_000, communeSurcharge: 1_000 })).toBe(6_000);
  });

  it('valeur par défaut des réglages sans frais de catégorie, sans majoration', () => {
    expect(visitFeeAmount({ categoryFee: null, defaultFee: 4_000 })).toBe(4_000);
    expect(visitFeeAmount({ categoryFee: null, defaultFee: 4_000, communeSurcharge: null })).toBe(4_000);
  });
});

describe('paiement (R-FV-02, R-FV-03)', () => {
  const pending = newVisitFee({ id: 'fee-1', rank: 1, amount: 5_000, now: NOW, paymentHours: 72 });

  it('crée des frais à payer avec une échéance de 72 h', () => {
    expect(pending).toEqual({
      id: 'fee-1',
      rank: 1,
      amount: 5_000,
      status: 'awaiting_payment',
      dueAt: at('2026-11-23T09:00:00Z'),
      paidAt: null,
      refundedAt: null,
    });
  });

  it('payés une milliseconde avant l’échéance : la demande passe « visite à planifier »', () => {
    const paidAt = at('2026-11-23T08:59:59.999Z');
    const result = payVisitFee(pending, 'awaiting_visit_fee', paidAt);
    expect(result.fee).toMatchObject({ status: 'paid', paidAt, dueAt: null });
    expect(result.requestStatus).toBe('visit_to_schedule');
  });

  it('à l’échéance exacte, la demande est annulée : paiement refusé', () => {
    const error = thrown(() => payVisitFee(pending, 'awaiting_visit_fee', at('2026-11-23T09:00:00Z')));
    expect(error.code).toBe('CLEANING_INVALID_TRANSITION');
    expect(error.details).toEqual({ from: 'cancelled', to: 'visit_to_schedule' });
  });

  it('rien à payer pour des frais déjà réglés', () => {
    expect(thrown(() => payVisitFee(fee(), 'visit_to_schedule', NOW)).code).toBe('CLEANING_NOTHING_TO_PAY');
  });

  it('refuse le paiement sur une demande close', () => {
    const error = thrown(() => payVisitFee(pending, 'rejected', NOW));
    expect(error.details).toEqual({ from: 'rejected', to: 'visit_to_schedule' });
  });
});

describe('nouveaux frais (R-VI-05)', () => {
  it('le rang suit le plus grand rang du dossier', () => {
    expect(nextVisitFeeRank([])).toBe(1);
    expect(nextVisitFeeRank([fee({ rank: 1 }), fee({ id: 'fee-2', rank: 2 })])).toBe(3);
  });

  it('les frais d’une visite manquée sont conservés', () => {
    expect(retainVisitFee(fee()).status).toBe('retained');
    expect(retainVisitFee(fee({ status: 'awaiting_payment' })).status).toBe('awaiting_payment');
  });
});

describe('remboursement (R-FV-06)', () => {
  it('rembourse en intégralité des frais payés', () => {
    const result = refundVisitFee(fee(), NOW);
    expect(result.refunded).toBe(5_000);
    expect(result.fee).toMatchObject({ status: 'refunded', refundedAt: NOW });
  });

  it('jamais deux fois, et rien pour des frais non payés', () => {
    const once = refundVisitFee(fee(), NOW).fee;
    expect(refundVisitFee(once, NOW)).toEqual({ fee: once, refunded: 0 });
    const pending = fee({ status: 'awaiting_payment', paidAt: null });
    expect(refundVisitFee(pending, NOW)).toEqual({ fee: pending, refunded: 0 });
  });
});

describe('frais qui couvrent la visite', () => {
  it('frais payés : la visite est couverte', () => {
    expect(feeCoveringNextVisit([fee({ status: 'retained' }), fee({ id: 'fee-2', rank: 2 })]).id).toBe(
      'fee-2',
    );
  });

  it('visite annulée par KSP : frais remboursés, la visite suivante est gratuite', () => {
    expect(feeCoveringNextVisit([fee({ status: 'refunded', refundedAt: NOW })]).id).toBe('fee-1');
  });

  it('frais à payer ou absents : CLEANING_VISIT_FEE_UNPAID', () => {
    const pending = fee({ id: 'fee-2', rank: 2, status: 'awaiting_payment', paidAt: null });
    expect(thrown(() => feeCoveringNextVisit([fee({ status: 'retained' }), pending])).code).toBe(
      'CLEANING_VISIT_FEE_UNPAID',
    );
    expect(thrown(() => feeCoveringNextVisit([])).code).toBe('CLEANING_VISIT_FEE_UNPAID');
  });
});

describe('déduction (R-FV-05)', () => {
  it('déduit les frais payés, réglage activé', () => {
    expect(deductibleVisitFeeAmount([fee({ status: 'retained', rank: 1 }), fee({ rank: 2 })], true)).toBe(
      5_000,
    );
  });

  it('rien à déduire : réglage désactivé, ou visite gratuite après remboursement', () => {
    expect(deductibleVisitFeeAmount([fee()], false)).toBe(0);
    expect(deductibleVisitFeeAmount([fee({ status: 'refunded', refundedAt: NOW })], true)).toBe(0);
  });

  it('à l’acceptation : frais payés déduits, ou conservés si la déduction est désactivée', () => {
    const fees = [fee({ status: 'retained' }), fee({ id: 'fee-2', rank: 2 })];
    expect(settleVisitFeesOnAcceptance(fees, true).map((item) => item.status)).toEqual([
      'retained',
      'deducted',
    ]);
    expect(settleVisitFeesOnAcceptance(fees, false).map((item) => item.status)).toEqual([
      'retained',
      'retained',
    ]);
  });

  it('portée par la première séance, au plus son montant dû, le reste par les suivantes', () => {
    expect(allocateVisitFeeDeduction(5_000, [3_000, 8_000, 8_000])).toEqual([3_000, 2_000, 0]);
    expect(allocateVisitFeeDeduction(5_000, [8_000, 8_000])).toEqual([5_000, 0]);
  });

  it('borne : jamais plus que le total dû, rien à répartir sans déduction', () => {
    expect(allocateVisitFeeDeduction(20_000, [3_000, 4_000])).toEqual([3_000, 4_000]);
    expect(allocateVisitFeeDeduction(0, [3_000])).toEqual([0]);
  });
});
