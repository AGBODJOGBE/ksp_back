import { applyPayment, type CaseAmounts, commissionBase, openingAmounts, totalDue } from './amounts';
import { addDays, localInstant } from './calendar';
import { advanceStage, type CaseState, changeStatus, close, newCase, reject, stageGroup } from './case';
import { remittanceDeadline } from './deadlines';
import { type ImportRow, validateImport } from './import';
import { type Outcome } from './outcome';
import {
  buildInstallments,
  DEFAULT_SCALES,
  type Installment,
  isWithinScale,
  payInstallments,
  planProgress,
  type PlanTerms,
  scaleViolations,
} from './payment-plan';
import { caseFee, commission, type PricingRule, rejectionRefund } from './pricing';
import { nextProgression } from './progression';
import { DEFAULT_SETTINGS } from './settings';

/**
 * Scénarios des critères d'acceptation des lots B et C (cahier des charges, partie 18), joués sur le
 * seul domaine : les cas d'usage, la base et les appels aux autres services viennent ensuite.
 */
function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.code} : ${outcome.reason}`);
  return outcome.value;
}

const RULE_BASE = {
  bounds: { minimum: null, maximum: null },
  target: { offer: 'any' as const, communeKey: null, creditorId: null },
  validFrom: new Date('2026-11-01T00:00:00Z'),
  validUntil: null,
  status: 'published' as const,
  version: 1,
  createdBy: 'admin-1',
  approvedBy: null,
  previousVersionId: null,
};
const FEE: PricingRule = {
  ...RULE_BASE,
  id: 'fee',
  object: 'case_fee',
  mode: { kind: 'fixed', fixedAmount: 10_000 },
};
const STUDY: PricingRule = {
  ...RULE_BASE,
  id: 'study',
  object: 'study_fee',
  mode: { kind: 'fixed', fixedAmount: 2_500 },
};
const COMMISSION: PricingRule = {
  ...RULE_BASE,
  id: 'commission',
  object: 'recovery_commission',
  mode: { kind: 'by_stage', stageRates: { amicable: 1_000, formal_notice: 1_500, litigation: 2_000 } },
  bounds: { minimum: 5_000, maximum: null },
};

describe('lot B : une entreprise importe 50 factures pour 12 débiteurs', () => {
  const rows: ImportRow[] = Array.from({ length: 50 }, (_, index) => {
    const debtor = index % 12;
    return {
      row: index + 1,
      values: {
        debtorKind: 'company',
        debtorName: `Client ${debtor}`,
        debtorFirstNames: '',
        debtorIfu: `32019000000${String(debtor).padStart(2, '0')}`,
        debtorPhone: `+229 01 97 00 00 ${String(debtor).padStart(2, '0')}`,
        debtorEmail: '',
        debtorAddress: '',
        invoiceReference: `FAC-2026-${index + 1}`,
        amount: '45 000',
        dueDate: '2026-09-30',
        description: '',
        nature: 'unpaid_invoice',
      },
    };
  });

  it('obtient 12 dossiers ; le superviseur en accepte 10, en refuse 1 et demande un complément pour 1', () => {
    const report = validateImport(rows, '2026-11-20', DEFAULT_SETTINGS.minimumCaseAmount);
    expect(report.lines.every((line) => line.status === 'valid')).toBe(true);
    expect(report.groups).toHaveLength(12);
    expect(report.groups.reduce((n, g) => n + g.rows.length, 0)).toBe(50);

    const reviewed = report.groups.map((group) => {
      expect(caseFee(FEE, group.total).amount).toBe(10_000);
      return value(changeStatus(value(changeStatus(newCase('b2b'), 'awaiting_fee')), 'under_review'));
    });
    const accepted = reviewed.slice(0, 10).map((s) => value(changeStatus(s, 'active')));
    const refused = value(reject(reviewed[10]!, 'no_evidence'));
    const incomplete = value(changeStatus(reviewed[11]!, 'info_requested'));

    expect(accepted.every((s) => s.status === 'active' && s.stage === 'notice')).toBe(true);
    expect(refused.status).toBe('rejected');
    // Frais remboursés au wallet, moins le forfait d'étude (4.4).
    expect(rejectionRefund(STUDY, 10_000)).toEqual({ retained: 2_500, refunded: 7_500 });
    expect(incomplete.status).toBe('info_requested');
  });
});

describe('lot C : un débiteur signe un échéancier de 3 mois, paie 2 échéances, en manque 2', () => {
  it('passe seul en relance amiable et chaque paiement est reversé net sous 5 jours ouvrés', () => {
    let state: CaseState = value(
      changeStatus(value(changeStatus(newCase('b2c'), 'awaiting_fee')), 'under_review'),
    );
    state = value(changeStatus(state, 'active'));
    let amounts: CaseAmounts = value(openingAmounts(400_000, 0));

    // Le débiteur signe depuis son lien : 40 000 le 1er décembre, puis 3 mensualités de 120 000.
    const terms: PlanTerms = {
      firstAmount: 40_000,
      firstDueDate: '2026-12-01',
      rhythm: 'monthly',
      installmentsCount: 3,
    };
    const total = totalDue(amounts);
    let installments: Installment[] = value(buildInstallments(total, terms));
    const violations = scaleViolations(total, installments, DEFAULT_SCALES.b2c, '2026-11-20');
    expect(isWithinScale(DEFAULT_SCALES.b2c, violations)).toBe(true);
    state = value(advanceStage(state, 'payment_plan')).state;

    let collectedBefore = 0;
    let commissionBefore = 0;
    for (const [day, amount] of [
      ['2026-12-01', 40_000],
      ['2027-01-02', 120_000],
    ] as const) {
      const paidAt = localInstant(day, 10);
      const applied = applyPayment(amounts, amount);
      amounts = applied.amounts;
      installments = payInstallments(installments, amount).installments;
      const base = commissionBase(applied.allocation);
      const { commission: fee, net } = commission(COMMISSION, {
        base,
        collectedBefore,
        commissionBefore,
        stageGroup: stageGroup(state.highestStage),
        closesCase: false,
      });
      collectedBefore += base;
      commissionBefore += fee;
      expect(fee + net).toBe(amount);
      // 10 % à l'amiable, au taux normal : le minimum de 5 000 FCFA vaut pour le cumul du dossier,
      // le premier versement de 40 000 FCFA donne donc 4 000 FCFA.
      expect(fee).toBe(amount / 10);
      // Crédité au wallet dès l'encaissement confirmé : bien avant la limite de 5 jours ouvrés.
      expect(remittanceDeadline(paidAt, DEFAULT_SETTINGS, new Set()) > day).toBe(true);
    }

    const options = {
      graceDays: DEFAULT_SETTINGS.installmentGraceDays,
      missedBeforeDefault: DEFAULT_SETTINGS.missedInstallmentsBeforeAmicable,
      renegotiated: false,
    };
    // Échéance du 1er février manquée : une seule, l'échéancier tient encore.
    expect(planProgress(installments, addDays('2027-02-01', 6), options)).toBe('on_track');
    // Échéance du 1er mars manquée aussi : rompu, le dossier passe seul en relance amiable.
    const progress = planProgress(installments, '2027-03-07', options);
    expect(progress).toBe('defaulted');
    const action = nextProgression({
      state,
      stageStartedAt: localInstant('2026-11-20', 10),
      now: localInstant('2027-03-07', 0, 5),
      planPending: false,
      planProgress: progress,
      settings: DEFAULT_SETTINGS,
    });
    expect(action).toEqual({ kind: 'advance', to: 'amicable' });
    if (action.kind !== 'advance') throw new Error('avancement attendu');
    state = value(advanceStage(state, action.to)).state;
    expect(state).toMatchObject({ stage: 'amicable', highestStage: 'amicable' });
    expect(totalDue(amounts)).toBe(240_000);

    // Le débiteur solde plus tard : le dossier se clôt « payé » (R-PR-01). Le minimum est déjà
    // atteint au cumul (16 000 FCFA) : aucun complément, 10 % de l'encaissement.
    const closing = applyPayment(amounts, 240_000);
    amounts = closing.amounts;
    expect(totalDue(amounts)).toBe(0);
    expect(
      commission(COMMISSION, {
        base: commissionBase(closing.allocation),
        collectedBefore,
        commissionBefore,
        stageGroup: stageGroup(state.highestStage),
        closesCase: true,
      }),
    ).toEqual({ commission: 24_000, net: 216_000, boundApplied: null });
    expect(value(close(state, 'paid')).closureReason).toBe('paid');
  });
});
