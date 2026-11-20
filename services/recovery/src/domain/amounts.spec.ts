import {
  addRecoverableCosts,
  allocate,
  applyPayment,
  type CaseAmounts,
  commissionBase,
  correctPrincipal,
  isFullyPaid,
  openingAmounts,
  settlementWithinScale,
  totalDue,
  totalPaid,
  waiveRemainder,
} from './amounts';
import { type Outcome } from './outcome';

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

/** 500 000 de principal, 20 000 d'intérêts, 30 000 de frais refacturables. */
function caseAmounts(): CaseAmounts {
  return value(addRecoverableCosts(value(openingAmounts(500_000, 20_000)), 30_000));
}

describe('montant dû et imputation (R-SD-08, R-EN-03)', () => {
  it('calcule le montant dû : principal + intérêts + frais − paiements', () => {
    expect(totalDue(caseAmounts())).toBe(550_000);
  });

  it('impute dans l’ordre frais → intérêts → principal', () => {
    expect(allocate(caseAmounts(), 40_000)).toEqual({
      costs: 30_000,
      interests: 10_000,
      principal: 0,
      overpayment: 0,
    });
    const { amounts, allocation } = applyPayment(caseAmounts(), 100_000);
    expect(allocation).toEqual({ costs: 30_000, interests: 20_000, principal: 50_000, overpayment: 0 });
    expect(totalDue(amounts)).toBe(450_000);
    expect(totalPaid(amounts)).toBe(100_000);
    expect(commissionBase(allocation)).toBe(70_000);
  });

  it('détecte un trop-perçu et solde le dossier (R-EN-05, R-PR-01)', () => {
    const { amounts, allocation } = applyPayment(caseAmounts(), 560_000);
    expect(allocation.overpayment).toBe(10_000);
    expect(isFullyPaid(amounts)).toBe(true);
  });

  it('impute les paiements partiels reçus avant la soumission', () => {
    const amounts = value(openingAmounts(100_000, 5_000, 25_000));
    expect(amounts.interests.paid).toBe(5_000);
    expect(amounts.principal.paid).toBe(20_000);
    expect(totalDue(amounts)).toBe(80_000);
  });

  it('refuse des montants invalides', () => {
    expect(openingAmounts(0, 0).ok).toBe(false);
    expect(openingAmounts(10.5, 0).ok).toBe(false);
    expect(openingAmounts(10_000, 0, 20_000).ok).toBe(false);
    expect(addRecoverableCosts(caseAmounts(), 0).ok).toBe(false);
  });
});

describe('corrections et accords', () => {
  it('corrige le principal après contestation, jamais sous ce qui est payé (R-PR-02)', () => {
    const paid = applyPayment(caseAmounts(), 150_000).amounts; // 100 000 sur le principal
    expect(value(correctPrincipal(paid, 300_000)).principal.owed).toBe(300_000);
    expect(correctPrincipal(paid, 90_000).ok).toBe(false);
  });

  it('accepte une remise dans le barème du créancier, sinon la soumet (R-PR-05)', () => {
    expect(settlementWithinScale(500_000, 400_000, 2_000)).toBe(true); // remise de 20 %
    expect(settlementWithinScale(500_000, 399_999, 2_000)).toBe(false);
    expect(settlementWithinScale(500_000, 600_000, 2_000)).toBe(false);
    expect(settlementWithinScale(500_000, 0, 2_000)).toBe(false);
    expect(settlementWithinScale(500_000, 450_000, 12_000)).toBe(false);
  });

  it('abandonne le reste quand l’accord transactionnel est exécuté', () => {
    const paid = applyPayment(caseAmounts(), 400_000).amounts;
    const settled = waiveRemainder(paid);
    expect(isFullyPaid(settled)).toBe(true);
    expect(totalPaid(settled)).toBe(400_000);
  });
});
