import { addDays, addMonths, daysBetween, type LocalDay } from './calendar';
import { ceilRate, isRate, isWholeAmount } from './money';
import { type Outcome, refusal, success } from './outcome';

/**
 * Échéanciers (cahier des charges, partie 6.1 ; étape 2 de la partie 5 ; messages `PlanScale`,
 * `PlanTerms`, `PaymentPlan` du contrat). Le barème par défaut de chaque offre se règle au back-office
 * et le créancier peut l'ajuster pour ses dossiers (4.1, « Préférences »). Un échéancier dans le barème
 * est validé par le chargé ; hors barème, par le superviseur puis le créancier (R-EC-01). Signé par le
 * débiteur, il vaut reconnaissance de dette (R-EC-02).
 */
export type PlanRhythm = 'weekly' | 'biweekly' | 'monthly';
export type PlanOffer = 'b2b' | 'b2c' | 'rent';

export interface PlanScale {
  /** Le créancier accepte un échéancier ; sinon toute proposition lui est soumise. */
  acceptsPaymentPlan: boolean;
  /** Durée maximale, en mois depuis le jour de la proposition. */
  maxDurationMonths: number;
  /** Premier versement minimum, en points de base du montant dû (1 000 = 10 %). */
  minFirstPaymentBps: number;
  /** Jours au plus avant le premier versement (15). */
  firstPaymentWithinDays: number;
  /** Versement minimum, en FCFA. */
  minInstallment: number;
  /** Remise maximale pour un paiement immédiat (R-PR-05) ; 0 = aucune remise proposée. */
  maxDiscountBps: number;
}

/**
 * Barèmes par défaut (6.1). Celui des loyers reprend le rattrapage de 3 mois au plus (9.2, étape 3) et
 * les autres valeurs du B2C (à valider).
 */
export const DEFAULT_SCALES: Record<PlanOffer, PlanScale> = {
  b2c: {
    acceptsPaymentPlan: true,
    maxDurationMonths: 6,
    minFirstPaymentBps: 1_000,
    firstPaymentWithinDays: 15,
    minInstallment: 5_000,
    maxDiscountBps: 0,
  },
  b2b: {
    acceptsPaymentPlan: true,
    maxDurationMonths: 12,
    minFirstPaymentBps: 1_000,
    firstPaymentWithinDays: 15,
    minInstallment: 25_000,
    maxDiscountBps: 0,
  },
  rent: {
    acceptsPaymentPlan: true,
    maxDurationMonths: 3,
    minFirstPaymentBps: 1_000,
    firstPaymentWithinDays: 15,
    minInstallment: 5_000,
    maxDiscountBps: 0,
  },
};

/** Barème d'un dossier : celui de l'offre, ajusté par les préférences du créancier. */
export function scaleFor(base: PlanScale, creditorPreferences: Partial<PlanScale> = {}): PlanScale {
  const merged = { ...base };
  for (const key of Object.keys(creditorPreferences) as (keyof PlanScale)[]) {
    const value = creditorPreferences[key];
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  return merged;
}

/** Problèmes d'un barème (bornes du contrat). Vide = valide. */
export function scaleProblems(scale: PlanScale): string[] {
  const problems: string[] = [];
  if (
    !Number.isSafeInteger(scale.maxDurationMonths) ||
    scale.maxDurationMonths < 1 ||
    scale.maxDurationMonths > 36
  ) {
    problems.push('durée maximale de 1 à 36 mois');
  }
  if (
    !Number.isSafeInteger(scale.firstPaymentWithinDays) ||
    scale.firstPaymentWithinDays < 1 ||
    scale.firstPaymentWithinDays > 90
  ) {
    problems.push('premier versement sous 1 à 90 jours');
  }
  if (!isRate(scale.minFirstPaymentBps)) problems.push('premier versement de 0 à 10 000 points de base');
  if (!isWholeAmount(scale.minInstallment)) problems.push('versement minimum entier');
  if (!isRate(scale.maxDiscountBps)) problems.push('remise de 0 à 10 000 points de base');
  return problems;
}

/** Conditions d'un échéancier proposé (`PlanTerms`). */
export interface PlanTerms {
  firstAmount: number;
  firstDueDate: LocalDay;
  rhythm: PlanRhythm;
  /** Échéances après le premier versement (1 à 52). */
  installmentsCount: number;
}

export interface Installment {
  /** Rang, à partir de 1 pour le premier versement. */
  rank: number;
  dueDate: LocalDay;
  amount: number;
  paidAmount: number;
}

export const MAX_INSTALLMENTS = 52;

function nthDueDate(first: LocalDay, rhythm: PlanRhythm, index: number): LocalDay {
  if (rhythm === 'weekly') return addDays(first, 7 * index);
  if (rhythm === 'biweekly') return addDays(first, 14 * index);
  return addMonths(first, index);
}

/**
 * Échéances d'un échéancier de `total` : le premier versement, puis le reste en parts égales au rythme
 * choisi ; la dernière échéance absorbe l'arrondi.
 */
export function buildInstallments(total: number, terms: PlanTerms): Outcome<Installment[]> {
  const { firstAmount, installmentsCount: count } = terms;
  if (!isWholeAmount(total) || total === 0 || !isWholeAmount(firstAmount) || firstAmount === 0) {
    return refusal('RECOVERY_PLAN_INVALID', 'Montants entiers et positifs');
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INSTALLMENTS || firstAmount >= total) {
    return refusal('RECOVERY_PLAN_INVALID', 'Nombre d’échéances ou premier versement incohérent');
  }
  const rest = total - firstAmount;
  const share = Math.floor(rest / count);
  if (share === 0) return refusal('RECOVERY_PLAN_INVALID', 'Échéances trop petites');
  const installments: Installment[] = [
    { rank: 1, dueDate: terms.firstDueDate, amount: firstAmount, paidAmount: 0 },
  ];
  for (let index = 1; index <= count; index += 1) {
    const amount = index === count ? rest - share * (count - 1) : share;
    installments.push({
      rank: index + 1,
      dueDate: nthDueDate(terms.firstDueDate, terms.rhythm, index),
      amount,
      paidAmount: 0,
    });
  }
  return success(installments);
}

/** Écarts au barème, valeurs du contrat (`PaymentPlan.violations`). */
export type ScaleViolation = 'duration' | 'first_payment' | 'installment_minimum';

/**
 * Contrôle d'une proposition contre le barème (6.1) : premier versement trop tard, déjà passé ou trop
 * petit (`first_payment`), durée (`duration`), échéance sous le minimum (`installment_minimum`).
 */
export function scaleViolations(
  total: number,
  installments: readonly Installment[],
  scale: PlanScale,
  today: LocalDay,
): ScaleViolation[] {
  const violations: ScaleViolation[] = [];
  const first = installments[0]!;
  const last = installments[installments.length - 1]!;
  const firstDelay = daysBetween(today, first.dueDate);
  if (
    firstDelay < 0 ||
    firstDelay > scale.firstPaymentWithinDays ||
    first.amount < ceilRate(total, scale.minFirstPaymentBps)
  ) {
    violations.push('first_payment');
  }
  if (last.dueDate > addMonths(today, scale.maxDurationMonths)) violations.push('duration');
  if (installments.some((i) => i.amount < scale.minInstallment)) violations.push('installment_minimum');
  return violations;
}

/**
 * Dans le barème : sans écart et accepté par le créancier ; le débiteur l'accepte et le signe tout de
 * suite (partie 7). Sinon il part au chargé, puis au superviseur et au créancier (`plan_off_scale`).
 */
export function isWithinScale(scale: PlanScale, violations: readonly ScaleViolation[]): boolean {
  return scale.acceptsPaymentPlan && violations.length === 0;
}

export type PlanStatus =
  'proposed' | 'pending_creditor' | 'signed' | 'completed' | 'defaulted' | 'rejected' | 'cancelled';

const PLAN_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  proposed: ['pending_creditor', 'signed', 'rejected'],
  pending_creditor: ['signed', 'rejected'],
  // Signé puis renégocié : l'ancien échéancier est annulé.
  signed: ['completed', 'defaulted', 'cancelled'],
  completed: [],
  defaulted: [],
  rejected: [],
  cancelled: [],
};

export function canTransitionPlan(from: PlanStatus, to: PlanStatus): boolean {
  return PLAN_TRANSITIONS[from].includes(to);
}

/** Un dossier admet un échéancier puis une seule renégociation (6.1, étape 3). */
export function canSignNewPlan(signedPlansInCase: number): Outcome<{ renegotiation: boolean }> {
  if (signedPlansInCase >= 2) {
    return refusal('RECOVERY_PLAN_RENEGOTIATION_EXHAUSTED', 'L’échéancier a déjà été renégocié une fois');
  }
  return success({ renegotiation: signedPlansInCase === 1 });
}

/**
 * Imputation d'un paiement sur les échéances, la plus ancienne d'abord ; un paiement d'avance couvre
 * les échéances suivantes et décale donc leurs rappels (R-EC-03).
 */
export function payInstallments(
  installments: readonly Installment[],
  amount: number,
): { installments: Installment[]; leftover: number } {
  let left = amount;
  const updated = installments.map((installment) => {
    const part = Math.min(left, installment.amount - installment.paidAmount);
    left -= part;
    return { ...installment, paidAmount: installment.paidAmount + part };
  });
  return { installments: updated, leftover: left };
}

function isUnpaid(installment: Installment): boolean {
  return installment.paidAmount < installment.amount;
}

function isMissed(installment: Installment, today: LocalDay, graceDays: number): boolean {
  return isUnpaid(installment) && daysBetween(addDays(installment.dueDate, graceDays), today) > 0;
}

/** Statut d'une échéance (`Installment.status`) : manquée après le jour d'échéance et la grâce (5 jours). */
export type InstallmentStatus = 'upcoming' | 'due' | 'paid' | 'partial' | 'missed';

export function installmentStatus(
  installment: Installment,
  today: LocalDay,
  graceDays: number,
): InstallmentStatus {
  if (!isUnpaid(installment)) return 'paid';
  if (isMissed(installment, today, graceDays)) return 'missed';
  if (installment.paidAmount > 0) return 'partial';
  return today >= installment.dueDate ? 'due' : 'upcoming';
}

/** Échéances manquées : non soldées après le jour d'échéance et les jours de grâce (5). */
export function missedInstallments(
  installments: readonly Installment[],
  today: LocalDay,
  graceDays: number,
): Installment[] {
  return installments.filter((i) => isMissed(i, today, graceDays));
}

export type PlanProgress = 'on_track' | 'completed' | 'defaulted';

/**
 * Suivi d'un échéancier signé : soldé, ou rompu à 2 échéances manquées (réglable), à 1 seule après une
 * renégociation (étape 2) — le dossier passe alors en relance amiable.
 */
export function planProgress(
  installments: readonly Installment[],
  today: LocalDay,
  options: { graceDays: number; missedBeforeDefault: number; renegotiated: boolean },
): PlanProgress {
  if (installments.every((i) => !isUnpaid(i))) return 'completed';
  const threshold = options.renegotiated ? 1 : options.missedBeforeDefault;
  return missedInstallments(installments, today, options.graceDays).length >= threshold
    ? 'defaulted'
    : 'on_track';
}

export interface Reminder {
  rank: number;
  day: LocalDay;
  kind: 'before' | 'due_day';
}

/** Rappels du jour : N jours avant (3) et le jour de chaque échéance non soldée (R-EC-03). */
export function remindersDue(
  installments: readonly Installment[],
  today: LocalDay,
  daysBefore: number,
): Reminder[] {
  const reminders: Reminder[] = [];
  for (const installment of installments) {
    if (!isUnpaid(installment)) continue;
    if (daysBefore > 0 && addDays(installment.dueDate, -daysBefore) === today) {
      reminders.push({ rank: installment.rank, day: today, kind: 'before' });
    }
    if (installment.dueDate === today)
      reminders.push({ rank: installment.rank, day: today, kind: 'due_day' });
  }
  return reminders;
}
