import {
  approveRule,
  archiveRule,
  caseFee,
  commission,
  type CommissionInput,
  type PricingMode,
  type PricingRule,
  type PricingTier,
  publishRule,
  rejectionRefund,
  resolveRule,
  ruleProblems,
  simulateCommission,
  studyFee,
} from './pricing';

const NOW = new Date('2026-11-20T10:00:00Z');

/** Encaissement ordinaire : rien de prélevé avant, ne solde pas le dossier (sauf précision). */
type Collection = Pick<CommissionInput, 'base' | 'collectedBefore' | 'stageGroup'> & Partial<CommissionInput>;
const commissionOf = (pricing: PricingRule, input: Collection) =>
  commission(pricing, { commissionBefore: 0, closesCase: false, ...input });

function rule(mode: PricingMode, overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    id: 'r1',
    object: 'recovery_commission',
    mode,
    bounds: { minimum: null, maximum: null },
    target: { offer: 'b2b', communeKey: null, creditorId: null },
    validFrom: new Date('2026-11-01T00:00:00Z'),
    validUntil: null,
    status: 'published',
    version: 1,
    createdBy: 'admin-1',
    approvedBy: null,
    previousVersionId: null,
    ...overrides,
  };
}

const rateTier = (upTo: number | null, rateBps: number): PricingTier => ({
  upTo,
  rateBps,
  fixedAmount: null,
});
const amountTier = (upTo: number | null, fixedAmount: number): PricingTier => ({
  upTo,
  rateBps: null,
  fixedAmount,
});

const BY_STAGE = rule(
  { kind: 'by_stage', stageRates: { amicable: 1_000, formal_notice: 1_500, litigation: 2_000 } },
  { bounds: { minimum: 5_000, maximum: null } },
);

describe('commission par encaissement (R-CO-01)', () => {
  it('applique le taux du groupe d’étapes atteint : 10 % / 15 % / 20 %', () => {
    expect(commissionOf(BY_STAGE, { base: 500_000, collectedBefore: 0, stageGroup: 'amicable' })).toEqual({
      commission: 50_000,
      net: 450_000,
      boundApplied: null,
    });
    expect(
      commissionOf(BY_STAGE, { base: 500_000, collectedBefore: 0, stageGroup: 'formal_notice' }).commission,
    ).toBe(75_000);
    expect(
      commissionOf(BY_STAGE, { base: 500_000, collectedBefore: 0, stageGroup: 'litigation' }).commission,
    ).toBe(100_000);
  });

  it('prend une mensualité de 5 000 FCFA au taux normal, sans minimum', () => {
    expect(commissionOf(BY_STAGE, { base: 5_000, collectedBefore: 0, stageGroup: 'amicable' })).toEqual({
      commission: 500,
      net: 4_500,
      boundApplied: null,
    });
    expect(commissionOf(BY_STAGE, { base: 0, collectedBefore: 0, stageGroup: 'amicable' })).toEqual({
      commission: 0,
      net: 0,
      boundApplied: null,
    });
  });

  it('complète jusqu’au minimum l’encaissement qui solde un dossier resté sous le minimum', () => {
    // Dossier de 30 000 FCFA en 3 versements de 10 000 : 1 000 + 1 000, puis 3 000 à la clôture.
    const first = commissionOf(BY_STAGE, { base: 10_000, collectedBefore: 0, stageGroup: 'amicable' });
    const second = commissionOf(BY_STAGE, {
      base: 10_000,
      collectedBefore: 10_000,
      commissionBefore: 1_000,
      stageGroup: 'amicable',
    });
    const last = commissionOf(BY_STAGE, {
      base: 10_000,
      collectedBefore: 20_000,
      commissionBefore: 2_000,
      stageGroup: 'amicable',
      closesCase: true,
    });
    expect([first.commission, second.commission]).toEqual([1_000, 1_000]);
    expect(last).toEqual({ commission: 3_000, net: 7_000, boundApplied: 'minimum' });
    expect(simulateCommission(BY_STAGE, 30_000, 'amicable', 3)).toEqual({
      collected: 30_000,
      commission: 5_000,
      net: 25_000,
    });
  });

  it('limite le complément au dernier encaissement, sans reprendre ce qui est reversé', () => {
    expect(
      commissionOf(BY_STAGE, {
        base: 1_500,
        collectedBefore: 28_500,
        commissionBefore: 2_850,
        stageGroup: 'amicable',
        closesCase: true,
      }),
    ).toEqual({ commission: 1_500, net: 0, boundApplied: 'minimum' });
  });

  it('n’ajoute aucun complément quand le minimum est atteint en plusieurs fois', () => {
    // 3 versements de 20 000 : 2 000 + 2 000 + 2 000 = 6 000, au-delà du minimum de 5 000.
    expect(
      commissionOf(BY_STAGE, {
        base: 20_000,
        collectedBefore: 40_000,
        commissionBefore: 4_000,
        stageGroup: 'amicable',
        closesCase: true,
      }),
    ).toEqual({ commission: 2_000, net: 18_000, boundApplied: null });
    expect(simulateCommission(BY_STAGE, 60_000, 'amicable', 3).commission).toBe(6_000);
  });

  it('applique le maximum', () => {
    const capped = rule(
      { kind: 'percentage', rateBps: 1_000 },
      { bounds: { minimum: null, maximum: 20_000 } },
    );
    expect(commissionOf(capped, { base: 500_000, collectedBefore: 0, stageGroup: 'amicable' })).toEqual({
      commission: 20_000,
      net: 480_000,
      boundApplied: 'maximum',
    });
  });

  it('n’arrondit qu’une fois sur la vie du dossier, au franc inférieur', () => {
    const percent = rule({ kind: 'percentage', rateBps: 1_250 });
    // 3 encaissements de 33 333 : 12,5 % du cumul 99 999 = 12 499,875 → 12 499.
    const at = (collectedBefore: number) =>
      commissionOf(percent, { base: 33_333, collectedBefore, stageGroup: 'amicable' }).commission;
    expect([at(0), at(33_333), at(66_666)]).toEqual([4_166, 4_167, 4_166]);
    expect(at(0) + at(33_333) + at(66_666)).toBe(12_499);
  });

  it('applique chaque tranche de taux à sa part : 15 % jusqu’à 1 000 000, 10 % au-delà', () => {
    const tiered = rule({ kind: 'tiered', tiers: [rateTier(1_000_000, 1_500), rateTier(null, 1_000)] });
    expect(
      commissionOf(tiered, { base: 1_500_000, collectedBefore: 0, stageGroup: 'amicable' }).commission,
    ).toBe(200_000);
    expect(
      commissionOf(tiered, { base: 600_000, collectedBefore: 800_000, stageGroup: 'amicable' }).commission,
    ).toBe(70_000);
    expect(simulateCommission(tiered, 1_500_000, 'amicable', 3)).toEqual({
      collected: 1_500_000,
      commission: 200_000,
      net: 1_300_000,
    });
  });

  it('applique un montant fixe par encaissement', () => {
    expect(
      commissionOf(rule({ kind: 'fixed', fixedAmount: 2_000 }), {
        base: 50_000,
        collectedBefore: 0,
        stageGroup: 'amicable',
      }),
    ).toEqual({ commission: 2_000, net: 48_000, boundApplied: null });
  });

  it('ne tire aucune commission de tranches en montants (mode des frais de dossier)', () => {
    const wrong = rule({ kind: 'tiered', tiers: [amountTier(null, 9_000)] });
    expect(commissionOf(wrong, { base: 50_000, collectedBefore: 0, stageGroup: 'amicable' }).commission).toBe(
      0,
    );
  });

  it('simule un dossier de 500 000 FCFA recouvré à l’amiable (R-TA-01)', () => {
    expect(simulateCommission(BY_STAGE, 500_000, 'amicable')).toEqual({
      collected: 500_000,
      commission: 50_000,
      net: 450_000,
    });
  });
});

describe('frais de dossier et forfait d’étude', () => {
  const brackets = rule(
    {
      kind: 'tiered',
      tiers: [amountTier(500_000, 10_000), amountTier(5_000_000, 25_000), amountTier(null, 50_000)],
    },
    { object: 'case_fee' },
  );

  it('fixe les frais selon la tranche du montant dû (R-SD-04)', () => {
    expect(caseFee(brackets, 500_000)).toEqual({ amount: 10_000, boundApplied: null });
    expect(caseFee(brackets, 500_001).amount).toBe(25_000);
    expect(caseFee(brackets, 9_000_000).amount).toBe(50_000);
    expect(caseFee(rule({ kind: 'fixed', fixedAmount: 7_500 }, { object: 'case_fee' }), 1).amount).toBe(
      7_500,
    );
    expect(caseFee(rule({ kind: 'percentage', rateBps: 100 }, { object: 'case_fee' }), 1).amount).toBe(0);
    const capped = rule(
      { kind: 'fixed', fixedAmount: 7_500 },
      { object: 'case_fee', bounds: { minimum: null, maximum: 5_000 } },
    );
    expect(caseFee(capped, 1)).toEqual({ amount: 5_000, boundApplied: 'maximum' });
  });

  it('rembourse les frais d’un dossier refusé ou classé, moins le forfait d’étude (4.4)', () => {
    const study = rule({ kind: 'fixed', fixedAmount: 3_000 }, { object: 'study_fee' });
    expect(rejectionRefund(study, 10_000)).toEqual({ retained: 3_000, refunded: 7_000 });
    expect(rejectionRefund(study, 2_000)).toEqual({ retained: 2_000, refunded: 0 });
    expect(rejectionRefund(null, 10_000)).toEqual({ retained: 0, refunded: 10_000 });
  });

  it('retient un forfait d’étude, jamais plus que les frais payés (4.4)', () => {
    const study = rule({ kind: 'fixed', fixedAmount: 3_000 }, { object: 'study_fee' });
    expect(studyFee(study, 10_000)).toBe(3_000);
    expect(studyFee(study, 2_000)).toBe(2_000);
    expect(studyFee(rule({ kind: 'percentage', rateBps: 10 }, { object: 'study_fee' }), 2_000)).toBe(0);
  });
});

describe('validation d’une règle (ADR-062, décision 5)', () => {
  it('accepte une règle complète', () => {
    expect(ruleProblems(BY_STAGE)).toEqual([]);
  });

  it('refuse un mode impossible pour l’objet', () => {
    expect(ruleProblems(rule({ kind: 'percentage', rateBps: 500 }, { object: 'case_fee' }))).toEqual([
      'mode percentage impossible pour case_fee',
    ]);
    expect(
      ruleProblems(rule({ kind: 'tiered', tiers: [rateTier(null, 500)] }, { object: 'case_fee' })),
    ).toEqual(['mode tiered impossible pour case_fee']);
    expect(ruleProblems(rule({ kind: 'tiered', tiers: [amountTier(null, 500)] }))).toEqual([
      'mode tiered impossible pour recovery_commission',
    ]);
    const byStage: PricingMode = {
      kind: 'by_stage',
      stageRates: { amicable: 0, formal_notice: 0, litigation: 0 },
    };
    expect(ruleProblems(rule(byStage, { object: 'study_fee' }))).toEqual([
      'mode by_stage impossible pour study_fee',
    ]);
  });

  it('refuse des montants, taux, tranches ou bornes incohérents', () => {
    expect(ruleProblems(rule({ kind: 'fixed', fixedAmount: -1 }))).toHaveLength(1);
    expect(ruleProblems(rule({ kind: 'percentage', rateBps: 10_001 }))).toHaveLength(1);
    expect(
      ruleProblems(
        rule({ kind: 'by_stage', stageRates: { amicable: 1_000, formal_notice: -1, litigation: 2_000 } }),
      ),
    ).toHaveLength(1);
    expect(
      ruleProblems(rule({ kind: 'tiered', tiers: [rateTier(null, 1_000), rateTier(500, 20_000)] })),
    ).toEqual(
      expect.arrayContaining([
        'seule la dernière tranche est sans limite',
        'la dernière tranche est sans limite',
        'taux de 0 à 10 000 points de base',
      ]),
    );
    expect(ruleProblems(rule({ kind: 'tiered', tiers: [] }))).toEqual(['au moins une tranche']);
    expect(
      ruleProblems(
        rule(
          { kind: 'tiered', tiers: [amountTier(1_000, 5), amountTier(500, 5), amountTier(null, 1.5)] },
          { object: 'case_fee' },
        ),
      ),
    ).toEqual(['tranches entières et croissantes', 'montants entiers positifs ou nuls']);
    expect(
      ruleProblems(rule({ kind: 'tiered', tiers: [rateTier(1_000, 100), amountTier(null, 5)] })),
    ).toEqual(['toutes les tranches portent un taux, ou toutes un montant']);
    expect(
      ruleProblems(rule({ kind: 'fixed', fixedAmount: 1 }, { bounds: { minimum: 10, maximum: 5 } })),
    ).toEqual(['le minimum dépasse le maximum']);
    expect(
      ruleProblems(rule({ kind: 'fixed', fixedAmount: 1 }, { bounds: { minimum: 1.5, maximum: null } })),
    ).toEqual(['bornes entières positives ou nulles']);
    expect(
      ruleProblems(
        rule(
          { kind: 'fixed', fixedAmount: 1 },
          {
            validUntil: new Date('2026-10-01T00:00:00Z'),
            target: { offer: 'b2b', communeKey: ' ', creditorId: '' },
          },
        ),
      ),
    ).toEqual(['la fin suit le début', 'commune vide', 'créancier vide']);
  });
});

describe('publication, validation et versions (13.1, R-TA-04)', () => {
  const draft = (overrides: Partial<PricingRule> = {}) =>
    rule({ kind: 'percentage', rateBps: 1_200 }, { id: 'r2', status: 'draft', version: 0, ...overrides });

  it('publie un brouillon, crée une version et archive la règle précédente', () => {
    expect(publishRule(draft({ validFrom: NOW }), [BY_STAGE], NOW)).toEqual({
      ok: true,
      value: {
        rule: expect.objectContaining({ status: 'published', version: 2 }),
        superseded: [{ ruleId: 'r1', action: 'archive' }],
      },
    });
  });

  it('fait finir la règle précédente au début d’une règle future', () => {
    const start = new Date('2027-01-01T00:00:00Z');
    const publication = publishRule(draft({ validFrom: start }), [BY_STAGE], NOW);
    expect(publication.ok && publication.value.superseded).toEqual([
      { ruleId: 'r1', action: 'end_at', validUntil: start },
    ]);
  });

  it('archive la version précédente même si la cible change', () => {
    const next = draft({
      validFrom: NOW,
      previousVersionId: 'r1',
      target: { offer: 'any', communeKey: null, creditorId: null },
    });
    expect(publishRule(next, [BY_STAGE], NOW)).toMatchObject({
      ok: true,
      value: { rule: { version: 2 }, superseded: [{ ruleId: 'r1', action: 'archive' }] },
    });
  });

  it('refuse un conflit, une règle incomplète ou une règle déjà publiée', () => {
    expect(
      publishRule(draft({ validFrom: new Date('2026-10-01T00:00:00Z') }), [BY_STAGE], NOW),
    ).toMatchObject({
      code: 'RECOVERY_PRICING_RULE_CONFLICT',
    });
    expect(publishRule(draft({ mode: { kind: 'percentage', rateBps: -5 } }), [], NOW)).toMatchObject({
      code: 'RECOVERY_PRICING_RULE_INVALID',
    });
    expect(publishRule(BY_STAGE, [], NOW)).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
  });

  it('met un tarif négocié en attente, puis le publie à la validation d’une deuxième personne', () => {
    const negotiated = draft({ target: { offer: 'b2b', communeKey: null, creditorId: 'org-9' } });
    const pending = publishRule(negotiated, [], NOW);
    expect(pending).toMatchObject({
      ok: true,
      value: { rule: { status: 'pending_approval' }, superseded: [] },
    });
    if (!pending.ok) throw new Error(pending.reason);
    expect(approveRule(pending.value.rule, 'admin-1', [], NOW)).toMatchObject({
      code: 'RECOVERY_APPROVAL_BY_REQUESTER',
    });
    expect(approveRule(pending.value.rule, 'admin-2', [], NOW)).toMatchObject({
      ok: true,
      value: { rule: { status: 'published', approvedBy: 'admin-2', version: 1 } },
    });
    expect(approveRule(negotiated, 'admin-2', [], NOW)).toMatchObject({
      code: 'RECOVERY_INVALID_TRANSITION',
    });
  });

  it('archive une règle publiée ou en attente seulement', () => {
    expect(archiveRule(BY_STAGE)).toMatchObject({ ok: true, value: { status: 'archived' } });
    expect(archiveRule(draft({ status: 'pending_approval' }))).toMatchObject({ ok: true });
    expect(archiveRule(draft())).toMatchObject({ code: 'RECOVERY_INVALID_TRANSITION' });
  });
});

describe('règle applicable (ADR-062, décision 4)', () => {
  const anyOffer = rule(
    { kind: 'percentage', rateBps: 1_100 },
    { id: 'any', target: { offer: 'any', communeKey: null, creditorId: null } },
  );
  const general = rule({ kind: 'percentage', rateBps: 1_000 }, { id: 'general' });
  const commune = rule(
    { kind: 'percentage', rateBps: 900 },
    { id: 'commune', target: { offer: 'b2b', communeKey: 'cotonou', creditorId: null } },
  );
  const negotiated = rule(
    { kind: 'percentage', rateBps: 800 },
    { id: 'negotiated', target: { offer: 'b2b', communeKey: null, creditorId: 'org-9' } },
  );
  const expired = rule(
    { kind: 'percentage', rateBps: 700 },
    {
      id: 'expired',
      target: { offer: 'b2b', communeKey: null, creditorId: 'org-9' },
      validUntil: new Date('2026-11-10T00:00:00Z'),
    },
  );
  const rules = [anyOffer, general, commune, negotiated, expired];
  const find = (offer: 'b2b' | 'b2c', communeKey: string | null, creditorId: string | null) =>
    resolveRule(rules, 'recovery_commission', { offer, communeKey, creditorId }, NOW)?.id;

  it('fait primer le créancier, puis l’offre et la commune, puis l’offre, puis « any »', () => {
    expect(find('b2b', 'cotonou', 'org-9')).toBe('negotiated');
    expect(find('b2b', 'cotonou', 'org-1')).toBe('commune');
    expect(find('b2b', 'porto-novo', null)).toBe('general');
    expect(find('b2c', null, null)).toBe('any');
  });

  it('ne trouve rien pour un autre objet', () => {
    expect(
      resolveRule(rules, 'case_fee', { offer: 'b2b', communeKey: null, creditorId: null }, NOW),
    ).toBeNull();
  });

  it('prend la plus récente à spécificité égale', () => {
    const newer = rule(
      { kind: 'percentage', rateBps: 1_100 },
      { id: 'newer', validFrom: new Date('2026-11-15T00:00:00Z') },
    );
    expect(
      resolveRule(
        [general, newer],
        'recovery_commission',
        { offer: 'b2b', communeKey: null, creditorId: null },
        NOW,
      )?.id,
    ).toBe('newer');
  });
});
