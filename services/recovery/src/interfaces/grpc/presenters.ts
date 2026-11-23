import { type recoveryV1 } from '@ksp/contracts';
import { type FullSettings, type StoredPricingRule, type StoredSettings } from '../../application/ports';
import { type PricingResult, type PricingRuleInput } from '../../application/pricing.use-cases';
import { type PlanScale } from '../../domain/payment-plan';
import { RecoveryErrors } from '../../application/shared/errors';

/**
 * Traductions entre les messages du contrat ksp.recovery.v1 et la couche application. Conventions du
 * contrat : montants `Money` en XOF, dates ISO 8601 (chaîne vide = absente), -1 = entier absent.
 */

type Money = { amount: number; currency: string };

export const money = (amount: number): Money => ({ amount, currency: 'XOF' });

/** Montant facultatif d'une requête : absent = null ; devise XOF et entier exigés. */
export function amountOf(field: string, value: Money | undefined): number | null {
  if (value === undefined) return null;
  if (value.currency && value.currency !== 'XOF')
    throw RecoveryErrors.invalid(field, 'Montant en XOF attendu.');
  return Number(value.amount);
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : '');

const ACTOR_STAFF = (userId: string | null) =>
  userId ? { type: 'staff', userId, displayName: '' } : undefined;

export function presentPricingRule(stored: StoredPricingRule): recoveryV1.PricingRule {
  const { rule } = stored;
  const mode = rule.mode;
  return {
    id: rule.id,
    object: rule.object,
    mode: mode.kind,
    fixedAmount: mode.kind === 'fixed' ? money(mode.fixedAmount) : undefined,
    rateBps: mode.kind === 'percentage' ? mode.rateBps : -1,
    tiers:
      mode.kind === 'tiered'
        ? mode.tiers.map((tier) => ({
            upTo: tier.upTo === null ? undefined : money(tier.upTo),
            rateBps: tier.rateBps ?? -1,
            fixedAmount: tier.fixedAmount === null ? undefined : money(tier.fixedAmount),
          }))
        : [],
    stageRates:
      mode.kind === 'by_stage'
        ? (['amicable', 'formal_notice', 'litigation'] as const).map((group) => ({
            stageGroup: group,
            rateBps: mode.stageRates[group],
          }))
        : [],
    minimum: rule.bounds.minimum === null ? undefined : money(rule.bounds.minimum),
    maximum: rule.bounds.maximum === null ? undefined : money(rule.bounds.maximum),
    target: {
      offer: rule.target.offer,
      communeKey: rule.target.communeKey ?? '',
      creditor:
        rule.target.creditorId && stored.creditorType
          ? { type: stored.creditorType, id: rule.target.creditorId, displayName: '' }
          : undefined,
    },
    validFrom: iso(rule.validFrom),
    validUntil: iso(rule.validUntil),
    version: rule.version,
    status: rule.status,
    label: stored.label,
    createdBy: ACTOR_STAFF(rule.createdBy),
    approvedBy: ACTOR_STAFF(rule.approvedBy),
    publishedAt: iso(stored.publishedAt),
    previousVersionId: rule.previousVersionId ?? '',
  };
}

/** Saisie d'une règle (PricingRuleInput) → couche application. */
export function pricingInputOf(input: recoveryV1.PricingRuleInput | undefined): PricingRuleInput {
  if (!input) throw RecoveryErrors.invalid('input', 'Saisie de la règle obligatoire.');
  return {
    object: input.object,
    mode: input.mode,
    fixedAmount: amountOf('fixedAmount', input.fixedAmount),
    rateBps: input.mode === 'percentage' ? input.rateBps : null,
    tiers: input.tiers.map((tier, index) => ({
      upTo: amountOf(`tiers[${index}].upTo`, tier.upTo),
      // Une tranche porte un taux ou un montant : le montant, s'il est donné, l'emporte.
      rateBps: tier.fixedAmount === undefined ? tier.rateBps : null,
      fixedAmount: amountOf(`tiers[${index}].fixedAmount`, tier.fixedAmount),
    })),
    stageRates: input.stageRates.map((rate) => ({ stageGroup: rate.stageGroup, rateBps: rate.rateBps })),
    minimum: amountOf('minimum', input.minimum),
    maximum: amountOf('maximum', input.maximum),
    offer: input.target?.offer ?? 'any',
    communeKey: input.target?.communeKey || null,
    creditor: input.target?.creditor?.id
      ? { type: input.target.creditor.type, id: input.target.creditor.id }
      : null,
    validFrom: input.validFrom || null,
    validUntil: input.validUntil || null,
    label: input.label,
    previousVersionId: input.previousVersionId || null,
  };
}

export function presentPricingResult(result: PricingResult): recoveryV1.SimulatePricingResponse {
  return {
    amount: money(result.amount),
    ruleId: result.rule.id,
    ruleVersion: result.rule.version,
    lines: result.lines.map((line) => ({
      label: line.label,
      base: money(line.base),
      rateBps: line.rateBps ?? -1,
      amount: money(line.amount),
    })),
    boundApplied: result.boundApplied ?? '',
  };
}

function presentScale(scale: PlanScale): recoveryV1.PlanScale {
  return {
    acceptsPaymentPlan: scale.acceptsPaymentPlan,
    maxDurationMonths: scale.maxDurationMonths,
    minFirstPaymentBps: scale.minFirstPaymentBps,
    firstPaymentWithinDays: scale.firstPaymentWithinDays,
    minInstallment: money(scale.minInstallment),
    maxDiscountBps: scale.maxDiscountBps,
  };
}

function scaleOf(field: string, scale: recoveryV1.PlanScale | undefined): PlanScale {
  if (!scale) throw RecoveryErrors.invalid(field, 'Barème obligatoire.');
  return {
    acceptsPaymentPlan: scale.acceptsPaymentPlan,
    maxDurationMonths: scale.maxDurationMonths,
    minFirstPaymentBps: scale.minFirstPaymentBps,
    firstPaymentWithinDays: scale.firstPaymentWithinDays,
    minInstallment: amountOf(`${field}.minInstallment`, scale.minInstallment) ?? 0,
    maxDiscountBps: scale.maxDiscountBps,
  };
}

export function presentSettings(stored: StoredSettings): recoveryV1.RecoverySettings {
  const s = stored.settings;
  return {
    minimumCaseAmount: money(s.minimumCaseAmount),
    feePaymentDays: s.feePaymentDays,
    reviewBusinessDays: s.reviewBusinessDays,
    infoCompletionDays: s.infoCompletionDays,
    noticeResponseDays: s.noticeResponseDays,
    installmentGraceDays: s.installmentGraceDays,
    missedInstallmentsBeforeAmicable: s.missedInstallmentsBeforeAmicable,
    amicableDurationDays: s.amicableDurationDays,
    formalNoticeDays: s.formalNoticeDays,
    creditorApprovalDays: s.creditorApprovalDays,
    disputeAnswerDays: s.disputeAnswerDays,
    prescriptionAlertDays: s.prescriptionAlertDays,
    contactWindow: {
      start: s.contactWindow.start,
      end: s.contactWindow.end,
      days: [...s.contactWindow.days],
    },
    debtorLinkDays: s.debtorLinkDays,
    remittanceBusinessDays: s.remittanceBusinessDays,
    closedCaseRetentionYears: s.closedCaseRetentionYears,
    defaultB2bScale: presentScale(s.scales.b2b),
    defaultB2cScale: presentScale(s.scales.b2c),
    defaultRentScale: presentScale(s.scales.rent),
    scoreWeights: { ...s.scoreWeights },
    planCreditorApprovalDays: s.planCreditorApprovalDays,
    partnerSilenceAlertDays: s.partnerSilenceAlertDays,
    debtorSessionMinutes: s.debtorSessionMinutes,
    unrecoverableAfterMonths: s.unrecoverableAfterMonths,
    updatedAt: iso(stored.updatedAt),
    updatedBy: ACTOR_STAFF(stored.updatedBy),
  };
}

/** Réglages envoyés par le back-office : tous obligatoires (UpdateRecoverySettings). */
export function settingsOf(input: recoveryV1.RecoverySettings | undefined): FullSettings {
  if (!input) throw RecoveryErrors.invalid('settings', 'Réglages obligatoires.');
  if (!input.contactWindow) throw RecoveryErrors.invalid('contactWindow', 'Plage de contact obligatoire.');
  if (!input.scoreWeights) throw RecoveryErrors.invalid('scoreWeights', 'Poids du score obligatoires.');
  return {
    minimumCaseAmount: amountOf('minimumCaseAmount', input.minimumCaseAmount) ?? -1,
    feePaymentDays: input.feePaymentDays,
    reviewBusinessDays: input.reviewBusinessDays,
    infoCompletionDays: input.infoCompletionDays,
    noticeResponseDays: input.noticeResponseDays,
    installmentGraceDays: input.installmentGraceDays,
    missedInstallmentsBeforeAmicable: input.missedInstallmentsBeforeAmicable,
    amicableDurationDays: input.amicableDurationDays,
    formalNoticeDays: input.formalNoticeDays,
    creditorApprovalDays: input.creditorApprovalDays,
    disputeAnswerDays: input.disputeAnswerDays,
    prescriptionAlertDays: input.prescriptionAlertDays,
    contactWindow: {
      start: input.contactWindow.start,
      end: input.contactWindow.end,
      days: [...input.contactWindow.days],
    },
    debtorLinkDays: input.debtorLinkDays,
    remittanceBusinessDays: input.remittanceBusinessDays,
    closedCaseRetentionYears: input.closedCaseRetentionYears,
    planCreditorApprovalDays: input.planCreditorApprovalDays,
    partnerSilenceAlertDays: input.partnerSilenceAlertDays,
    debtorSessionMinutes: input.debtorSessionMinutes,
    unrecoverableAfterMonths: input.unrecoverableAfterMonths,
    scales: {
      b2b: scaleOf('defaultB2bScale', input.defaultB2bScale),
      b2c: scaleOf('defaultB2cScale', input.defaultB2cScale),
      rent: scaleOf('defaultRentScale', input.defaultRentScale),
    },
    scoreWeights: { ...input.scoreWeights },
  };
}
