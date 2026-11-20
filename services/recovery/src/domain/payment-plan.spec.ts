import { type Outcome } from './outcome';
import {
  buildInstallments,
  canSignNewPlan,
  canTransitionPlan,
  DEFAULT_SCALES,
  type Installment,
  installmentStatus,
  isWithinScale,
  missedInstallments,
  payInstallments,
  planProgress,
  type PlanTerms,
  remindersDue,
  scaleFor,
  scaleProblems,
  scaleViolations,
} from './payment-plan';

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.value;
}

const TODAY = '2026-11-20';
const TOTAL = 300_000;

/** 300 000 FCFA : 30 000 le 1er décembre, puis 3 mensualités de 90 000. */
const TERMS: PlanTerms = {
  firstAmount: 30_000,
  firstDueDate: '2026-12-01',
  rhythm: 'monthly',
  installmentsCount: 3,
};

describe('échéances d’une proposition (PlanTerms)', () => {
  it('répartit le reste en parts égales, la dernière absorbe l’arrondi', () => {
    expect(value(buildInstallments(TOTAL, TERMS)).map((i) => [i.rank, i.dueDate, i.amount])).toEqual([
      [1, '2026-12-01', 30_000],
      [2, '2027-01-01', 90_000],
      [3, '2027-02-01', 90_000],
      [4, '2027-03-01', 90_000],
    ]);
    const uneven = value(buildInstallments(300_001, { ...TERMS, rhythm: 'weekly' }));
    expect(uneven.map((i) => i.amount)).toEqual([30_000, 90_000, 90_000, 90_001]);
    expect(uneven[3]!.dueDate).toBe('2026-12-22');
    expect(value(buildInstallments(TOTAL, { ...TERMS, rhythm: 'biweekly' }))[1]!.dueDate).toBe('2026-12-15');
  });

  it('refuse des conditions incohérentes', () => {
    expect(buildInstallments(0, TERMS)).toMatchObject({ code: 'RECOVERY_PLAN_INVALID' });
    expect(buildInstallments(TOTAL, { ...TERMS, installmentsCount: 0 }).ok).toBe(false);
    expect(buildInstallments(TOTAL, { ...TERMS, installmentsCount: 53 }).ok).toBe(false);
    expect(buildInstallments(TOTAL, { ...TERMS, firstAmount: 300_000 }).ok).toBe(false);
    expect(buildInstallments(TOTAL, { ...TERMS, firstAmount: 0 }).ok).toBe(false);
    expect(buildInstallments(30_002, TERMS).ok).toBe(false);
  });
});

describe('barème (6.1, PlanScale)', () => {
  const b2c = DEFAULT_SCALES.b2c;

  it('accepte une proposition dans le barème B2C', () => {
    const installments = value(buildInstallments(TOTAL, TERMS));
    expect(scaleViolations(TOTAL, installments, b2c, TODAY)).toEqual([]);
    expect(isWithinScale(b2c, [])).toBe(true);
    expect(isWithinScale({ ...b2c, acceptsPaymentPlan: false }, [])).toBe(false);
  });

  it('signale les écarts du contrat : premier versement, durée, minimum', () => {
    const late: PlanTerms = {
      ...TERMS,
      firstDueDate: '2026-12-20',
      firstAmount: 20_000,
      installmentsCount: 7,
    };
    expect(scaleViolations(TOTAL, value(buildInstallments(TOTAL, late)), b2c, TODAY)).toEqual([
      'first_payment',
      'duration',
    ]);
    // 270 000 en 12 semaines : 22 500 par échéance, sous le minimum B2B de 25 000.
    const weekly: PlanTerms = { ...TERMS, rhythm: 'weekly', installmentsCount: 12 };
    expect(
      scaleViolations(TOTAL, value(buildInstallments(TOTAL, weekly)), DEFAULT_SCALES.b2b, TODAY),
    ).toEqual(['installment_minimum']);
    const past: PlanTerms = { ...TERMS, firstDueDate: '2026-11-19' };
    expect(scaleViolations(TOTAL, value(buildInstallments(TOTAL, past)), b2c, TODAY)).toEqual([
      'first_payment',
    ]);
    expect(isWithinScale(b2c, ['duration'])).toBe(false);
  });

  it('applique les préférences du créancier et contrôle un barème', () => {
    const scale = scaleFor(DEFAULT_SCALES.b2b, { maxDurationMonths: 3, minInstallment: undefined });
    expect(scale).toMatchObject({ maxDurationMonths: 3, minInstallment: 25_000 });
    expect(scaleProblems(scale)).toEqual([]);
    expect(scaleProblems(DEFAULT_SCALES.rent)).toEqual([]);
    expect(
      scaleProblems({
        acceptsPaymentPlan: true,
        maxDurationMonths: 0,
        firstPaymentWithinDays: 0,
        minFirstPaymentBps: 20_000,
        minInstallment: 1.5,
        maxDiscountBps: -1,
      }),
    ).toHaveLength(5);
  });
});

describe('cycle de vie et suivi (étape 2, R-EC-01 à 03)', () => {
  it('suit les états de l’échéancier, annulé quand il est renégocié', () => {
    expect(canTransitionPlan('proposed', 'signed')).toBe(true);
    expect(canTransitionPlan('pending_creditor', 'rejected')).toBe(true);
    expect(canTransitionPlan('signed', 'cancelled')).toBe(true);
    expect(canTransitionPlan('signed', 'proposed')).toBe(false);
  });

  it('permet une seule renégociation', () => {
    expect(value(canSignNewPlan(0))).toEqual({ renegotiation: false });
    expect(value(canSignNewPlan(1))).toEqual({ renegotiation: true });
    expect(canSignNewPlan(2)).toMatchObject({ code: 'RECOVERY_PLAN_RENEGOTIATION_EXHAUSTED' });
  });

  it('impute un paiement sur la plus ancienne échéance, l’excédent d’avance sur les suivantes', () => {
    const { installments, leftover } = payInstallments(value(buildInstallments(TOTAL, TERMS)), 150_000);
    expect(installments.map((i) => i.paidAmount)).toEqual([30_000, 90_000, 30_000, 0]);
    expect(leftover).toBe(0);
    expect(payInstallments(installments, 500_000).leftover).toBe(350_000);
  });

  it('donne le statut de chaque échéance', () => {
    const [first, second, third] = payInstallments(
      value(buildInstallments(TOTAL, TERMS)),
      150_000,
    ).installments;
    expect(installmentStatus(first!, '2026-12-10', 5)).toBe('paid');
    expect(installmentStatus(third!, '2027-01-15', 5)).toBe('partial');
    expect(installmentStatus(third!, '2027-02-07', 5)).toBe('missed');
    const fresh = value(buildInstallments(TOTAL, TERMS));
    expect(installmentStatus(fresh[0]!, '2026-11-30', 5)).toBe('upcoming');
    expect(installmentStatus(fresh[0]!, '2026-12-03', 5)).toBe('due');
    expect(second).toMatchObject({ paidAmount: 90_000 });
  });

  it('compte une échéance manquée après 5 jours de grâce', () => {
    const installments = value(buildInstallments(TOTAL, TERMS));
    expect(missedInstallments(installments, '2026-12-06', 5)).toHaveLength(0);
    expect(missedInstallments(installments, '2026-12-07', 5)).toHaveLength(1);
  });

  it('rompt l’échéancier à 2 échéances manquées, à 1 après renégociation', () => {
    const installments = value(buildInstallments(TOTAL, TERMS));
    const options = { graceDays: 5, missedBeforeDefault: 2, renegotiated: false };
    expect(planProgress(installments, '2026-12-07', options)).toBe('on_track');
    expect(planProgress(installments, '2026-12-07', { ...options, renegotiated: true })).toBe('defaulted');
    expect(planProgress(installments, '2027-01-07', options)).toBe('defaulted');
    const paid = payInstallments(installments, TOTAL).installments;
    expect(planProgress(paid, '2027-06-01', options)).toBe('completed');
  });

  it('rappelle 3 jours avant et le jour de l’échéance, pas une échéance payée d’avance', () => {
    const installments: Installment[] = value(buildInstallments(TOTAL, TERMS));
    expect(remindersDue(installments, '2026-11-28', 3)).toEqual([
      { rank: 1, day: '2026-11-28', kind: 'before' },
    ]);
    expect(remindersDue(installments, '2026-12-01', 3)).toEqual([
      { rank: 1, day: '2026-12-01', kind: 'due_day' },
    ]);
    const ahead = payInstallments(installments, 120_000).installments;
    expect(remindersDue(ahead, '2027-01-01', 3)).toEqual([]);
    expect(remindersDue(installments, '2026-11-28', 0)).toEqual([]);
  });
});
