import { type PricingRuleInput } from './pricing.use-cases';
import { createUseCases } from './use-cases';
import {
  ADMIN_ID,
  AGENT_ID,
  asCreditor,
  asStaff,
  CREDITOR_ID,
  FINANCE_ID,
  makeDeps,
  NOW,
  ORGANIZATION_ID,
  rejection,
  SECOND_ADMIN_ID,
} from './testing/fakes';

const input = (change: Partial<PricingRuleInput> = {}): PricingRuleInput => ({
  object: 'recovery_commission',
  mode: 'by_stage',
  fixedAmount: null,
  rateBps: null,
  tiers: [],
  stageRates: [
    { stageGroup: 'amicable', rateBps: 1_000 },
    { stageGroup: 'formal_notice', rateBps: 1_500 },
    { stageGroup: 'litigation', rateBps: 2_000 },
  ],
  minimum: 5_000,
  maximum: null,
  offer: 'any',
  communeKey: null,
  creditor: null,
  validFrom: null,
  validUntil: null,
  label: 'Commission par étape 2026',
  previousVersionId: null,
  ...change,
});

const caseFeeInput = (change: Partial<PricingRuleInput> = {}) =>
  input({
    object: 'case_fee',
    mode: 'tiered',
    stageRates: [],
    minimum: null,
    tiers: [
      { upTo: 500_000, rateBps: null, fixedAmount: 10_000 },
      { upTo: 2_000_000, rateBps: null, fixedAmount: 25_000 },
      { upTo: null, rateBps: null, fixedAmount: 50_000 },
    ],
    label: 'Frais de dossier par tranche',
    ...change,
  });

describe('tarification du recouvrement (ADR-062, lot A côté recouvrement)', () => {
  let deps: ReturnType<typeof makeDeps>;
  let useCases: ReturnType<typeof createUseCases>;

  beforeEach(() => {
    deps = makeDeps();
    useCases = createUseCases(deps);
  });

  const asAdmin = <T>(fn: () => Promise<T>, userId = ADMIN_ID) => asStaff(userId, ['recovery_admin'], fn);
  const create = (rule: PricingRuleInput, key = 'rule-key-0001', userId = ADMIN_ID) =>
    asAdmin(() => useCases.createPricingRule.execute({ idempotencyKey: key, input: rule }), userId);
  const publish = (ruleId: string, userId = ADMIN_ID) =>
    asAdmin(() => useCases.publishPricingRule.execute({ ruleId }), userId);

  it('critère du lot A : une commission par étape publiée, simulée sur un dossier de 500 000 FCFA', async () => {
    const draft = await create(input());
    expect(draft.rule).toMatchObject({ status: 'draft', version: 0 });
    const published = await publish(draft.rule.id);
    expect(published.rule).toMatchObject({ status: 'published', version: 1 });
    expect(published.publishedAt).toEqual(NOW);

    const simulate = (stage: string) =>
      asStaff(FINANCE_ID, ['finance_officer'], () =>
        useCases.simulatePricing.execute({
          ruleId: '',
          object: 'recovery_commission',
          offer: 'b2b',
          communeKey: null,
          creditorId: null,
          baseAmount: 500_000,
          stage,
        }),
      );
    const amicable = await simulate('amicable');
    expect(amicable).toMatchObject({ amount: 50_000, boundApplied: null, rule: { id: draft.rule.id } });
    expect(amicable.lines).toEqual([
      { label: 'Commission à l’amiable', base: 500_000, rateBps: 1_000, amount: 50_000 },
      { label: 'Reversé au créancier', base: 500_000, rateBps: null, amount: 450_000 },
    ]);
    expect((await simulate('formal_notice')).amount).toBe(75_000);
    expect((await simulate('bailiff')).amount).toBe(100_000);
    expect(deps.audit.entries.map((e) => e.action)).toEqual([
      'pricing_rule.created',
      'pricing_rule.published',
    ]);
  });

  it('minimum au cumul du dossier : un petit dossier soldé atteint le minimum', async () => {
    const draft = await create(input());
    const result = await asStaff(FINANCE_ID, ['finance_officer'], () =>
      useCases.simulatePricing.execute({
        ruleId: draft.rule.id,
        object: '',
        offer: '',
        communeKey: null,
        creditorId: null,
        baseAmount: 30_000,
        stage: '',
      }),
    );
    expect(result).toMatchObject({ amount: 5_000, boundApplied: 'minimum' });
  });

  it('création idempotente : même saisie, même règle ; autre saisie avec la même clé, refusée', async () => {
    const first = await create(input());
    const again = await create(input());
    expect(again.rule.id).toBe(first.rule.id);
    expect(deps.rules.rules.size).toBe(1);
    expect((await rejection(create(input({ label: 'Autre' })))).code).toBe('RECOVERY_IDEMPOTENCY_KEY_REUSED');
  });

  it('une règle incomplète reste un brouillon et sa publication est refusée', async () => {
    const draft = await create(
      input({
        stageRates: [
          { stageGroup: 'amicable', rateBps: 1_000 },
          { stageGroup: 'formal_notice', rateBps: 1_500 },
          { stageGroup: 'litigation', rateBps: 20_000 },
        ],
      }),
    );
    const error = await rejection(publish(draft.rule.id));
    expect(error.code).toBe('RECOVERY_PRICING_RULE_INVALID');
    expect(error.details.violations).toEqual(
      expect.arrayContaining([expect.stringContaining('points de base')]),
    );
    expect((await deps.rules.find(draft.rule.id))!.rule.status).toBe('draft');
  });

  it('frais de dossier en tranches de montants : mode refusé pour une commission en taux mélangés', async () => {
    const mixed = await create(
      caseFeeInput({ tiers: [{ upTo: null, rateBps: 1_000, fixedAmount: null }] }),
      'rule-key-0002',
    );
    expect((await rejection(publish(mixed.rule.id))).code).toBe('RECOVERY_PRICING_RULE_INVALID');
  });

  it('une nouvelle version publiée archive la précédente ; un brouillon publié ne se modifie plus', async () => {
    const v1 = await create(input());
    await publish(v1.rule.id);
    deps.clock.current = new Date(NOW.getTime() + 120_000);
    const v2 = await create(input({ previousVersionId: v1.rule.id, minimum: 7_500 }), 'rule-key-0002');
    const published = await publish(v2.rule.id);
    expect(published.rule.version).toBe(2);
    expect((await deps.rules.find(v1.rule.id))!.rule.status).toBe('archived');
    const error = await rejection(
      asAdmin(() => useCases.updatePricingRule.execute({ ruleId: v2.rule.id, input: input() })),
    );
    expect(error.code).toBe('RECOVERY_INVALID_TRANSITION');
  });

  it('tarif négocié : validé par une deuxième personne, jamais par son auteur (R-TA-04)', async () => {
    const negotiated = input({
      creditor: { type: 'organization', id: ORGANIZATION_ID },
      label: 'Tarif SARL',
    });
    const draft = await create(negotiated);
    const pending = await publish(draft.rule.id);
    expect(pending.rule.status).toBe('pending_approval');
    const self = await rejection(
      asAdmin(() => useCases.approvePricingRule.execute({ ruleId: draft.rule.id })),
    );
    expect(self.code).toBe('RECOVERY_APPROVAL_BY_REQUESTER');
    const approved = await asAdmin(
      () => useCases.approvePricingRule.execute({ ruleId: draft.rule.id }),
      SECOND_ADMIN_ID,
    );
    expect(approved.rule).toMatchObject({ status: 'published', approvedBy: SECOND_ADMIN_ID });
  });

  it('archivage : motif obligatoire, puis la règle sort des règles en vigueur', async () => {
    const draft = await create(input());
    await publish(draft.rule.id);
    expect(
      (
        await rejection(
          asAdmin(() => useCases.archivePricingRule.execute({ ruleId: draft.rule.id, reason: '' })),
        )
      ).code,
    ).toBe('RECOVERY_VALIDATION_FAILED');
    const archived = await asAdmin(() =>
      useCases.archivePricingRule.execute({ ruleId: draft.rule.id, reason: 'Nouvelle grille' }),
    );
    expect(archived).toMatchObject({ rule: { status: 'archived' }, archiveReason: 'Nouvelle grille' });
  });

  it('liste et fiche : lecture pour la finance, création réservée aux administrateurs', async () => {
    const draft = await create(input());
    const list = await asStaff(FINANCE_ID, ['finance_officer'], () =>
      useCases.listPricingRules.execute({
        object: 'recovery_commission',
        statuses: ['draft'],
        offer: '',
        creditorId: '',
      }),
    );
    expect(list.items.map((stored) => stored.rule.id)).toEqual([draft.rule.id]);
    const unknown = await rejection(
      asStaff(FINANCE_ID, ['finance_officer'], () =>
        useCases.getPricingRule.execute({ ruleId: '0192f1c4-0000-7000-8000-0000000fffff' }),
      ),
    );
    expect(unknown.code).toBe('RECOVERY_PRICING_RULE_NOT_FOUND');
    const forbidden = await rejection(
      asStaff(FINANCE_ID, ['finance_officer'], () =>
        useCases.createPricingRule.execute({ idempotencyKey: 'rule-key-0009', input: input() }),
      ),
    );
    expect(forbidden.code).toBe('AUTH_FORBIDDEN');
    const agent = await rejection(
      asStaff(AGENT_ID, ['recovery_agent'], () =>
        useCases.listPricingRules.execute({ object: '', statuses: [], offer: '', creditorId: '' }),
      ),
    );
    expect(agent.code).toBe('AUTH_FORBIDDEN');
  });

  it('publication : double authentification de moins de 10 minutes', async () => {
    const draft = await create(input());
    const error = await rejection(
      asStaff(
        ADMIN_ID,
        ['recovery_admin'],
        () => useCases.publishPricingRule.execute({ ruleId: draft.rule.id }),
        900,
      ),
    );
    expect(error.code).toBe('AUTH_MFA_REQUIRED');
  });

  describe('estimation des frais avant l’envoi (EstimateCaseFees, R-TA-03)', () => {
    beforeEach(async () => {
      await publish((await create(input(), 'rule-key-0101')).rule.id);
      await publish((await create(caseFeeInput(), 'rule-key-0102')).rule.id);
    });

    it('rend les frais de la tranche, la commission lisible et les règles figées', async () => {
      const estimate = await asCreditor(() =>
        useCases.estimateCaseFees.execute({ kind: 'b2b', amountDue: 750_000, communeKey: null }),
      );
      expect(estimate).toMatchObject({ caseFee: 25_000, minimumAmountDue: 25_000 });
      expect(estimate.commissionSummary).toBe(
        '10 % à l’amiable, 15 % après mise en demeure, 20 % au contentieux ; minimum 5 000 FCFA par dossier',
      );
      expect(estimate.stageRates).toEqual([
        { stageGroup: 'amicable', rateBps: 1_000 },
        { stageGroup: 'formal_notice', rateBps: 1_500 },
        { stageGroup: 'litigation', rateBps: 2_000 },
      ]);
    });

    it('un tarif négocié pour l’organisation du créancier l’emporte', async () => {
      const negotiated = await create(
        input({ creditor: { type: 'organization', id: ORGANIZATION_ID }, minimum: null, label: 'Négocié' }),
        'rule-key-0103',
      );
      await publish(negotiated.rule.id);
      await asAdmin(
        () => useCases.approvePricingRule.execute({ ruleId: negotiated.rule.id }),
        SECOND_ADMIN_ID,
      );
      const estimate = await asCreditor(
        () => useCases.estimateCaseFees.execute({ kind: 'b2b', amountDue: 100_000, communeKey: null }),
        ORGANIZATION_ID,
      );
      expect(estimate.commissionRule.id).toBe(negotiated.rule.id);
      const personal = await asCreditor(() =>
        useCases.estimateCaseFees.execute({ kind: 'b2b', amountDue: 100_000, communeKey: null }),
      );
      expect(personal.commissionRule.id).not.toBe(negotiated.rule.id);
      expect(CREDITOR_ID).toBeTruthy();
    });

    it('refuse un montant sous le minimum d’un dossier (R-SD-05)', async () => {
      const error = await rejection(
        asCreditor(() =>
          useCases.estimateCaseFees.execute({ kind: 'b2c', amountDue: 20_000, communeKey: null }),
        ),
      );
      expect(error).toMatchObject({ code: 'RECOVERY_AMOUNT_BELOW_MINIMUM' });
    });

    it('sans règle publiée applicable : refus explicite', async () => {
      const empty = createUseCases(makeDeps());
      const error = await rejection(
        asCreditor(() =>
          empty.estimateCaseFees.execute({ kind: 'b2c', amountDue: 50_000, communeKey: null }),
        ),
      );
      expect(error.code).toBe('RECOVERY_PRICING_RULE_INVALID');
    });
  });
});
