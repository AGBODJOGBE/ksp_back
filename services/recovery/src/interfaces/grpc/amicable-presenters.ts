import { type recoveryV1 } from '@ksp/contracts';
import {
  type InstallmentRecord,
  type PlanRecord,
  type PromiseRecord,
  type SettlementRecord,
} from '../../application/amicable/amicable.ports';
import { type WorkItemView } from '../../application/amicable/case-work.use-cases';
import { type DecisionView } from '../../application/amicable/decisions.use-cases';
import { type PlanSimulation, type TermsInput } from '../../application/amicable/payment-plans.use-cases';
import { presentSummary } from './case-presenters';
import { amountOf, money } from './presenters';

/**
 * Traductions de la procédure amiable (lot R4) entre le contrat ksp.recovery.v1 et la couche
 * application. Conventions du contrat : montants `Money` en XOF, dates ISO 8601 (chaîne vide =
 * absente), jours « AAAA-MM-JJ ».
 */

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : '');

/** Conditions d'un échéancier reçues (`PlanTerms`) ; absentes : null. */
export function termsInputOf(terms: recoveryV1.PlanTerms | undefined): TermsInput | null {
  if (!terms) return null;
  return {
    firstAmount: amountOf('terms.firstAmount', terms.firstAmount),
    firstDueDate: terms.firstDueDate,
    rhythm: terms.rhythm,
    installmentsCount: terms.installmentsCount,
  };
}

export function presentInstallment(installment: InstallmentRecord): recoveryV1.Installment {
  return {
    id: installment.id,
    rank: installment.rank,
    dueDate: installment.dueDate,
    amount: money(installment.amount),
    paidAmount: money(installment.paidAmount),
    status: installment.status,
    paidAt: iso(installment.paidAt),
  };
}

export function presentPlan(plan: PlanRecord): recoveryV1.PaymentPlan {
  return {
    id: plan.id,
    status: plan.status,
    terms: {
      firstAmount: money(plan.terms.firstAmount),
      firstDueDate: plan.terms.firstDueDate,
      rhythm: plan.terms.rhythm,
      installmentsCount: plan.terms.installmentsCount,
    },
    total: money(plan.total),
    installments: plan.installments.map(presentInstallment),
    withinScale: plan.withinScale,
    violations: plan.violations,
    proposedBy: plan.proposedBy.type,
    renegotiation: plan.renegotiatedFromId !== null,
    documentId: plan.documentId ?? '',
    signedAt: iso(plan.signedAt),
    missedCount: plan.installments.filter((installment) => installment.status === 'missed').length,
    createdAt: iso(plan.createdAt),
  };
}

export function presentSimulation(simulation: PlanSimulation): recoveryV1.SimulateDebtorPaymentPlanResponse {
  return {
    installments: simulation.installments.map(presentInstallment),
    total: money(simulation.total),
    withinScale: simulation.withinScale,
    violations: simulation.violations,
  };
}

export function presentPromise(promise: PromiseRecord): recoveryV1.PromiseToPay {
  return {
    id: promise.id,
    amount: money(promise.amount),
    dueDate: promise.dueDate,
    status: promise.status,
    recordedBy: { type: 'staff', userId: promise.createdBy, displayName: '' },
    createdAt: iso(promise.createdAt),
  };
}

export function presentSettlement(settlement: SettlementRecord): recoveryV1.Settlement {
  return {
    id: settlement.id,
    payNow: money(settlement.payNow),
    waived: money(settlement.waived),
    discountBps: settlement.discountBps,
    validUntil: settlement.validUntil,
    status: settlement.status,
  };
}

export function presentDecision(view: DecisionView): recoveryV1.Decision {
  const decision = view.decision;
  return {
    id: decision.id,
    caseId: decision.caseId,
    caseNumber: view.caseNumber,
    kind: decision.kind,
    status: decision.status,
    createdAt: iso(decision.requestedAt),
    expiresAt: iso(decision.expiresAt),
    paymentPlan: view.plan ? presentPlan(view.plan) : undefined,
    settlement: view.settlement ? presentSettlement(view.settlement) : undefined,
    feeQuote: undefined,
    dispute: undefined,
    answeredAt: iso(decision.decidedAt),
  };
}

export function presentWorkItem(item: WorkItemView): recoveryV1.WorkItem {
  return { kind: item.kind, case: presentSummary(item.summary), dueAt: iso(item.dueAt), note: item.note };
}
