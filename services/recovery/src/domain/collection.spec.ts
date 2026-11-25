import { type CaseAmounts } from './amounts';
import { type CollectionInput, computeCollection } from './collection';
import { review } from './offline-payment';
import { type PricingRule } from './pricing';

const rule = (mode: PricingRule['mode'], bounds: PricingRule['bounds'] = { minimum: null, maximum: null }) =>
  ({
    id: 'rule',
    object: 'recovery_commission',
    mode,
    bounds,
    target: { offer: 'any', communeKey: null, creditorId: null },
    validFrom: new Date('2026-01-01T00:00:00Z'),
    validUntil: null,
    status: 'published',
    version: 1,
    createdBy: 'admin',
    approvedBy: null,
    previousVersionId: null,
  }) satisfies PricingRule;

const amounts = (costs: number, interests: number, principal: number): CaseAmounts => ({
  costs: { owed: costs, paid: 0 },
  interests: { owed: interests, paid: 0 },
  principal: { owed: principal, paid: 0 },
});

const BY_STAGE = rule({
  kind: 'by_stage',
  stageRates: { amicable: 1_000, formal_notice: 1_500, litigation: 2_000 },
});

function input(change: Partial<CollectionInput> = {}): CollectionInput {
  return {
    gross: 100_000,
    source: 'payment_link',
    amounts: amounts(0, 0, 500_000),
    highestStage: 'notice',
    rule: BY_STAGE,
    totals: { base: 0, commission: 0 },
    commissionDue: true,
    open: true,
    ...change,
  };
}

const compute = (change: Partial<CollectionInput> = {}) => {
  const outcome = computeCollection(input(change));
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
};

describe('encaissement (R-EN-03, R-CO-01 à 03)', () => {
  it('impute frais, puis intérêts, puis principal ; seuls intérêts et principal sont commissionnés', () => {
    const result = compute({ gross: 60_000, amounts: amounts(20_000, 30_000, 500_000) });
    expect(result.allocation).toEqual({
      costs: 20_000,
      interests: 30_000,
      principal: 10_000,
      overpayment: 0,
    });
    expect(result.commissionBase).toBe(40_000);
    expect(result.commission).toBe(4_000);
    // Les frais recouvrés reviennent au créancier, qui les a provisionnés (R-CO-06).
    expect(result.net).toBe(56_000);
    expect(result.creditedGross).toBe(60_000);
    expect(result.dueAfter).toBe(490_000);
    expect(result.effectiveRateBps).toBe(666);
  });

  it('prend le taux du groupe de l’étape la plus avancée atteinte', () => {
    expect(compute({ highestStage: 'formal_notice' }).commission).toBe(15_000);
    expect(compute({ highestStage: 'bailiff' }).commission).toBe(20_000);
  });

  it('note le trop-perçu sans le commissionner ni le créditer, et clôt le dossier soldé', () => {
    const result = compute({ gross: 120_000, amounts: amounts(0, 0, 100_000) });
    expect(result.allocation.overpayment).toBe(20_000);
    expect(result.commission).toBe(10_000);
    expect(result.creditedGross).toBe(100_000);
    expect(result.net).toBe(90_000);
    expect(result.closesCase).toBe(true);
    expect(result.dueAfter).toBe(0);
  });

  it('ne rouvre ni ne reclôt un dossier déjà clos : tout est trop-perçu', () => {
    const paid: CaseAmounts = {
      costs: { owed: 0, paid: 0 },
      interests: { owed: 0, paid: 0 },
      principal: { owed: 100_000, paid: 100_000 },
    };
    const result = compute({ gross: 5_000, amounts: paid, open: false });
    expect(result.allocation.overpayment).toBe(5_000);
    expect(result.commission).toBe(0);
    expect(result.closesCase).toBe(false);
    expect(result.creditedGross).toBe(0);
  });

  it('paiement direct : commission facturée au créancier, rien de crédité', () => {
    const result = compute({ source: 'direct_to_creditor' });
    expect(result.settlement).toBe('invoiced');
    expect(result.commission).toBe(10_000);
    expect(result.net).toBe(0);
    expect(result.creditedGross).toBe(0);
  });

  it('paliers progressifs sur le cumul encaissé, un seul arrondi', () => {
    const tiered = rule({
      kind: 'tiered',
      tiers: [
        { upTo: 1_000_000, rateBps: 1_500, fixedAmount: null },
        { upTo: null, rateBps: 1_000, fixedAmount: null },
      ],
    });
    const first = compute({ rule: tiered, gross: 900_000, amounts: amounts(0, 0, 2_000_000) });
    expect(first.commission).toBe(135_000);
    const second = compute({
      rule: tiered,
      gross: 200_000,
      amounts: { ...amounts(0, 0, 2_000_000), principal: { owed: 2_000_000, paid: 900_000 } },
      totals: first.totalsAfter,
    });
    // 100 000 à 15 % puis 100 000 à 10 %.
    expect(second.commission).toBe(25_000);
    expect(second.totalsAfter).toEqual({ base: 1_100_000, commission: 160_000 });
  });

  it('maximum par encaissement ; minimum au cumul complété à l’encaissement qui solde', () => {
    const bounded = rule({ kind: 'percentage', rateBps: 1_000 }, { minimum: 30_000, maximum: 15_000 });
    const first = compute({ rule: bounded, gross: 200_000, amounts: amounts(0, 0, 300_000) });
    expect(first.commission).toBe(15_000);
    expect(first.boundApplied).toBe('maximum');
    const last = compute({
      rule: bounded,
      gross: 100_000,
      amounts: { ...amounts(0, 0, 300_000), principal: { owed: 300_000, paid: 200_000 } },
      totals: first.totalsAfter,
    });
    expect(last.closesCase).toBe(true);
    expect(last.commission).toBe(15_000);
    expect(last.boundApplied).toBe('minimum');
  });

  it('commission non due (paiement direct longtemps après l’arrêt) : rien de pris', () => {
    const result = compute({ source: 'direct_to_creditor', commissionDue: false });
    expect(result.commission).toBe(0);
    expect(result.totalsAfter).toEqual({ base: 0, commission: 0 });
  });

  it('refuse un montant nul ou décimal', () => {
    expect(computeCollection(input({ gross: 0 })).ok).toBe(false);
    expect(computeCollection(input({ gross: 10.5 })).ok).toBe(false);
  });
});

describe('validation à deux (R-AR-03)', () => {
  const pending = { status: 'pending_approval' as const, recordedBy: 'finance-a' };

  it('une autre personne valide ou refuse', () => {
    expect(review(pending, 'finance-b', 'approved')).toEqual({ ok: true, value: 'approved' });
    expect(review(pending, 'finance-b', 'rejected')).toEqual({ ok: true, value: 'rejected' });
  });

  it('jamais l’auteur de la saisie, jamais une saisie déjà traitée', () => {
    expect(review(pending, 'finance-a', 'approved')).toMatchObject({
      ok: false,
      code: 'RECOVERY_APPROVAL_BY_REQUESTER',
    });
    expect(review({ ...pending, status: 'approved' }, 'finance-b', 'rejected')).toMatchObject({
      ok: false,
      code: 'RECOVERY_INVALID_TRANSITION',
    });
  });
});
