import { type recoveryV1 } from '@ksp/contracts';
import { type OverviewView } from '../../application/cases/admin-cases.use-cases';
import { type CaseInputData } from '../../application/cases/case-input';
import { debtorDisplayName } from '../../application/cases/case-rules';
import { type CaseSummaryView, type CaseView } from '../../application/cases/case-views';
import { type ImportView } from '../../application/cases/case-imports.use-cases';
import { type JournalView } from '../../application/cases/creditor-cases.use-cases';
import {
  type CaseDocumentData,
  type CaseScore,
  type CreditorDashboardFigures,
  type EvidenceActor,
  type StageTransitionData,
  type StoredCreditorPreferences,
} from '../../application/cases/ports';
import { type ImportLineValues } from '../../domain/import';
import { type PlanScale } from '../../domain/payment-plan';
import { RecoveryErrors } from '../../application/shared/errors';
import { amountOf, money } from './presenters';

/**
 * Traductions des dossiers (lot R2) entre le contrat ksp.recovery.v1 et la couche application.
 * Conventions du contrat : montants `Money` en XOF, dates ISO 8601 (chaîne vide = absente), -1 =
 * entier absent. Un membre du personnel apparaît comme `staff` (`agent` dans le journal de preuve).
 */

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : '');

export function actorOf(actor: EvidenceActor, displayName = ''): recoveryV1.Actor {
  return { type: actor.type === 'agent' ? 'staff' : actor.type, userId: actor.id ?? '', displayName };
}

const staff = (userId: string | null, displayName: string) =>
  userId ? { type: 'staff', userId, displayName } : undefined;

export function planScaleOf(field: string, scale: recoveryV1.PlanScale | undefined): PlanScale | null {
  if (!scale) return null;
  return {
    acceptsPaymentPlan: scale.acceptsPaymentPlan,
    maxDurationMonths: scale.maxDurationMonths,
    minFirstPaymentBps: scale.minFirstPaymentBps,
    firstPaymentWithinDays: scale.firstPaymentWithinDays,
    minInstallment: amountOf(`${field}.minInstallment`, scale.minInstallment) ?? 0,
    maxDiscountBps: scale.maxDiscountBps,
  };
}

export function presentPlanScale(scale: PlanScale): recoveryV1.PlanScale {
  return {
    acceptsPaymentPlan: scale.acceptsPaymentPlan,
    maxDurationMonths: scale.maxDurationMonths,
    minFirstPaymentBps: scale.minFirstPaymentBps,
    firstPaymentWithinDays: scale.firstPaymentWithinDays,
    minInstallment: money(scale.minInstallment),
    maxDiscountBps: scale.maxDiscountBps,
  };
}

/** Saisie d'un dossier (`CaseInput`) → couche application ; absente : null. */
export function caseInputOf(input: recoveryV1.CaseInput | undefined): CaseInputData | null {
  if (!input) return null;
  return {
    kind: input.kind,
    nature: input.nature,
    debtors: input.debtors.map((debtor) => ({
      kind: debtor.kind,
      role: debtor.role,
      firstNames: debtor.firstNames,
      lastName: debtor.lastName,
      legalName: debtor.legalName,
      ifu: debtor.ifu,
      rccm: debtor.rccm,
      representativeName: debtor.representativeName,
      phones: debtor.phones,
      emails: debtor.emails,
      address: debtor.address,
      communeKey: debtor.communeKey,
    })),
    claims: input.claims.map((claim, index) => ({
      reference: claim.reference,
      amount: amountOf(`claims[${index}].amount`, claim.amount),
      dueDate: claim.dueDate,
      description: claim.description,
    })),
    interests: amountOf('interests', input.interests),
    alreadyPaid: amountOf('alreadyPaid', input.alreadyPaid),
    priorEffort: input.priorEffort
      ? {
          remindersCount: input.priorEffort.remindersCount,
          lastReminderDate: input.priorEffort.lastReminderDate,
          channels: input.priorEffort.channels,
          debtAcknowledged: input.priorEffort.debtAcknowledged,
          acknowledgmentFileId: input.priorEffort.acknowledgmentFileId,
          promisesReceived: input.priorEffort.promisesReceived,
          preserveRelationship: input.priorEffort.preserveRelationship,
        }
      : null,
    planScale: planScaleOf('planScale', input.planScale),
    evidenceFileIds: input.evidenceFileIds,
  };
}

export function importValuesOf(
  values: recoveryV1.ImportLineValues | undefined,
): Partial<ImportLineValues> | null {
  return values ? { ...values } : null;
}

export function presentDocument(document: CaseDocumentData, authorName = ''): recoveryV1.CaseDocument {
  return {
    id: document.id,
    kind: document.kind,
    fileId: document.fileId ?? '',
    documentId: document.documentId ?? '',
    label: document.label,
    addedBy: actorOf(document.addedBy, authorName),
    addedAt: iso(document.addedAt),
    visibleToDebtor: document.visibleToDebtor,
  };
}

function presentTransition(transition: StageTransitionData): recoveryV1.StageTransition {
  return {
    fromStage: transition.from ?? '',
    toStage: transition.to,
    at: iso(transition.at),
    by: actorOf(transition.by),
    reason: transition.reason ?? '',
    skipReason: transition.skipReason ?? '',
  };
}

/** Fiche d'un dossier (`RecoveryCase`). Les objets des lots suivants restent vides en R2. */
export function presentCase(view: CaseView): recoveryV1.RecoveryCase {
  const record = view.record;
  const fee = record.fee;
  const refunded = fee.refundedAt ? fee.amount - (fee.studyFeeChargedAt ? fee.studyFee : 0) : 0;
  return {
    id: record.id,
    number: record.number,
    kind: record.kind,
    nature: record.nature,
    status: record.status,
    stage: record.stage ?? '',
    creditor: { type: record.creditor.type, id: record.creditor.id, displayName: view.creditorName },
    debtors: record.debtors.map((debtor) => ({
      id: debtor.id,
      kind: debtor.kind,
      role: debtor.role,
      firstNames: debtor.firstNames ?? '',
      lastName: debtor.lastName ?? '',
      legalName: debtor.legalName ?? '',
      ifu: debtor.ifu ?? '',
      rccm: debtor.rccm ?? '',
      representativeName: debtor.representativeName ?? '',
      phones: debtor.contacts
        .filter((contact) => contact.channel === 'phone')
        .map((contact) => contact.value),
      emails: debtor.contacts
        .filter((contact) => contact.channel === 'email')
        .map((contact) => contact.value),
      address: debtor.address ?? '',
      communeKey: debtor.communeKey ?? '',
      displayName: debtorDisplayName(debtor),
    })),
    claims: record.claims.map((claim) => ({
      id: claim.id,
      reference: claim.reference,
      amount: money(claim.principal),
      dueDate: claim.dueDate,
      description: claim.description ?? '',
    })),
    priorEffort: {
      remindersCount: record.priorEffort.remindersCount,
      lastReminderDate: record.priorEffort.lastReminderDate ?? '',
      channels: record.priorEffort.channels,
      debtAcknowledged: record.priorEffort.acknowledged,
      acknowledgmentFileId: record.priorEffort.acknowledgmentFileId ?? '',
      promisesReceived: record.priorEffort.promises ?? '',
      preserveRelationship: record.preserveRelationship,
    },
    planScale: presentPlanScale(view.planScale),
    amounts: {
      principal: money(view.amounts.principal),
      interests: money(view.amounts.interests),
      costs: money(view.amounts.costs),
      paid: money(view.amounts.paid),
      waived: money(view.amounts.waived),
      due: money(view.amounts.due),
      overpaid: money(view.amounts.overpaid),
    },
    prescriptionDate: record.prescriptionDate ?? '',
    score: record.score?.value ?? -1,
    assignedAgent: staff(record.assignedAgentId, view.agentName),
    partnerAssignment: undefined,
    mandate: record.mandate
      ? {
          documentId: record.mandate.documentId,
          signatureRequestId: record.mandate.signatureRequestId ?? '',
          status: record.mandate.signedAt ? 'signed' : 'pending_signature',
          signedAt: iso(record.mandate.signedAt),
        }
      : undefined,
    fee:
      fee.amount > 0 || fee.paidAt
        ? {
            amount: money(fee.amount),
            status: fee.refundedAt ? 'refunded' : fee.paidAt ? 'paid' : 'unpaid',
            paidAt: iso(fee.paidAt),
            refundedAmount: money(refunded),
            walletTransactionId: fee.debitTransactionId ?? '',
          }
        : undefined,
    pricing: record.pricing
      ? {
          feeRuleId: record.pricing.feeRuleId,
          feeRuleVersion: record.pricing.feeRuleVersion,
          commissionRuleId: record.pricing.commissionRuleId,
          commissionRuleVersion: record.pricing.commissionRuleVersion,
          commissionSummary: record.pricing.commissionSummary,
        }
      : undefined,
    currentPlan: undefined,
    promises: [],
    collections: [],
    documents: record.documents.map((document) => presentDocument(document)),
    disputes: [],
    notices: [],
    feeQuotes: [],
    provisions: [],
    stageHistory: view.stageHistory.map(presentTransition),
    nextDeadline: view.nextDeadline
      ? { kind: view.nextDeadline.kind, dueAt: iso(view.nextDeadline.dueAt) }
      : undefined,
    reviewNote: record.reviewNote ?? '',
    closure: undefined,
    source: record.source,
    maxDiscountBps: view.planScale.maxDiscountBps,
    createdAt: iso(record.createdAt),
    submittedAt: iso(record.submittedAt),
    acceptedAt: iso(record.acceptedAt),
    updatedAt: iso(record.updatedAt),
    rejectionReason: record.rejectionReason ?? '',
  };
}

export function presentSummary(view: CaseSummaryView): recoveryV1.CaseSummary {
  const summary = view.summary;
  return {
    id: summary.id,
    number: summary.number,
    kind: summary.kind,
    status: summary.status,
    stage: summary.stage ?? '',
    creditor: { type: summary.creditor.type, id: summary.creditor.id, displayName: view.creditorName },
    debtorName: summary.debtorName,
    due: money(view.due),
    paid: money(summary.paid),
    score: summary.score ?? -1,
    assignedAgent: staff(summary.assignedAgentId, view.agentName),
    nextDeadline: view.nextDeadline
      ? { kind: view.nextDeadline.kind, dueAt: iso(view.nextDeadline.dueAt) }
      : undefined,
    lastActionAt: iso(summary.lastActionAt),
    createdAt: iso(summary.createdAt),
  };
}

export function presentJournal(view: JournalView): recoveryV1.JournalEntry[] {
  return view.entries.map(({ entry, authorName }) => ({
    id: entry.id,
    kind: entry.kind,
    channel: entry.channel ?? '',
    direction: entry.direction ?? '',
    outcome: entry.outcome ?? '',
    deliveryStatus: entry.deliveryStatus ?? '',
    summary: entry.summary,
    amount: entry.amount === null ? undefined : money(entry.amount),
    author: actorOf(entry.actor, authorName),
    internal: entry.internal,
    documentId: entry.ref?.type === 'document' ? entry.ref.id : '',
    fileId: entry.ref?.type === 'file' ? entry.ref.id : '',
    occurredAt: iso(entry.occurredAt),
  }));
}

export function presentImport(view: ImportView): recoveryV1.CaseImport {
  const record = view.record;
  return {
    id: record.id,
    status: record.status,
    kind: record.kind,
    linesTotal: record.lines.length,
    linesValid: record.lines.filter((line) => line.status === 'valid').length,
    linesInvalid: record.lines.filter((line) => line.status === 'invalid').length,
    casesPlanned: view.casesPlanned,
    lines: record.lines.map((line) => ({
      row: line.row,
      status: line.status,
      values: { ...line.values },
      errors: line.errors.map((error) => ({ field: error.field, code: error.code })),
    })),
    caseIds: view.caseIds,
    createdAt: iso(record.createdAt),
  };
}

export function presentPreferences(preferences: StoredCreditorPreferences): recoveryV1.CreditorPreferences {
  return {
    b2bScale: preferences.b2bScale ? presentPlanScale(preferences.b2bScale) : undefined,
    b2cScale: preferences.b2cScale ? presentPlanScale(preferences.b2cScale) : undefined,
    notifyUserIds: preferences.notifyUserIds,
  };
}

const EVIDENCE_LABELS: Record<string, string> = { strong: 'solides', medium: 'moyennes', weak: 'faibles' };

/** Détail du score (critère, valeur retenue, note de 0 à 100 avant pondération). */
export function presentScoreFactors(score: CaseScore | null): recoveryV1.ScoreFactor[] {
  if (!score) return [];
  const { inputs, breakdown } = score;
  const values: Record<keyof CaseScore['breakdown'], string> = {
    debtAge: `${inputs.debtAgeDays} jours`,
    writtenAcknowledgment: inputs.writtenAcknowledgment ? 'oui' : 'non',
    evidenceQuality: EVIDENCE_LABELS[inputs.evidenceQuality] ?? inputs.evidenceQuality,
    amount: `${inputs.amountDue} FCFA`,
    validContacts: String(inputs.validContactCount),
    partialPayments: inputs.partialPaymentsMade ? 'oui' : 'non',
  };
  return (Object.keys(breakdown) as (keyof CaseScore['breakdown'])[]).map((criterion) => ({
    criterion,
    value: values[criterion],
    points: breakdown[criterion],
  }));
}

export function presentDashboard(
  figures: CreditorDashboardFigures & { recoveryRateBps: number },
): recoveryV1.GetMyDashboardResponse {
  return {
    entrusted: money(figures.entrusted),
    recovered: money(figures.recovered),
    outstanding: money(figures.outstanding),
    recoveryRateBps: figures.recoveryRateBps,
    casesByStage: figures.casesByStage.map((item) => ({ stage: item.stage, count: item.count })),
    pendingDecisions: figures.pendingDecisions,
    upcomingInstallments: figures.upcomingInstallments.map((item) => ({
      caseId: item.caseId,
      caseNumber: item.caseNumber,
      debtorName: item.debtorName,
      dueDate: item.dueDate,
      amount: money(item.amount),
    })),
  };
}

export function presentOverview(view: OverviewView): recoveryV1.GetRecoveryOverviewResponse {
  const figures = view.figures;
  return {
    casesByStage: figures.casesByStage,
    casesByKind: figures.casesByKind,
    entrusted: money(figures.entrusted),
    recovered: money(figures.recovered),
    recoveryRateBps: view.recoveryRateBps,
    recoveryRateByStageBps: view.recoveryRateByStage.map((item) => ({
      stage: item.stage,
      count: item.rateBps,
    })),
    agents: view.agents.map((agent) => ({
      agent: { type: 'staff', userId: agent.agentId, displayName: agent.name },
      openCases: agent.openCases,
      recovered: money(agent.recovered),
      recoveryRateBps: agent.recoveryRateBps,
    })),
    installmentsDueToday: figures.installmentsDueToday,
    promisesToCheck: figures.promisesToCheck,
    idleCases: figures.idleCases,
    prescriptionsNear: figures.prescriptionsNear,
    reviewQueue: figures.reviewQueue,
    offlinePaymentsToApprove: figures.offlinePaymentsToApprove,
  };
}

/** Préférences envoyées par le créancier (`CreditorPreferences`). */
export function preferencesOf(input: recoveryV1.CreditorPreferences | undefined) {
  if (!input) throw RecoveryErrors.invalid('preferences', 'Préférences obligatoires.');
  return {
    b2bScale: planScaleOf('b2bScale', input.b2bScale),
    b2cScale: planScaleOf('b2cScale', input.b2cScale),
    notifyUserIds: input.notifyUserIds,
  };
}
