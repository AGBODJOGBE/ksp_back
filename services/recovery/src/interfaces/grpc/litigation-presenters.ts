import { type recoveryV1 } from '@ksp/contracts';
import { type LegalActRecord, noticeStatus } from '../../application/litigation/litigation.ports';
import {
  type AssignmentView,
  type NoticeView,
  type PartnerView,
} from '../../application/litigation/litigation-views';
import { type AssignmentFileView } from '../../application/litigation/partner-access.use-cases';
import { type PartnerInputData } from '../../application/litigation/partners.use-cases';
import { successRateBp } from '../../domain/partner';
import { presentPlan } from './amicable-presenters';
import { presentCase, presentDocument } from './case-presenters';
import { presentPartnerRef } from './escalation-presenters';
import { amountOf, money } from './presenters';

/**
 * Traductions du contentieux (lot R5) vers le contrat ksp.recovery.v1 : mise en demeure, devis,
 * partenaire et ses chiffres, assignation et ses actes, dossier prêt du partenaire. Conventions du
 * contrat : dates ISO 8601 (chaîne vide = absente), montants `Money`, -1 = entier absent.
 */

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : '');

export function presentNotice(view: NoticeView): recoveryV1.FormalNotice {
  const notice = view.notice;
  return {
    id: notice.id,
    documentId: notice.documentId,
    status: noticeStatus(notice),
    signedBy: notice.signedBy
      ? { type: 'staff', userId: notice.signedBy, displayName: view.signedByName }
      : undefined,
    issuedAt: iso(notice.issuedAt),
    deliveryMethod: notice.deliveryMethod ?? '',
    deliveredAt: iso(notice.deliveredAt),
    proofFileId: notice.proofFileId ?? '',
    deadlineAt: iso(notice.deadlineAt),
  };
}

export function presentAct(act: LegalActRecord): recoveryV1.LegalAct {
  return {
    id: act.id,
    type: act.type,
    actDate: act.actDate,
    cost: money(act.cost),
    fileId: act.fileId ?? '',
    note: act.note ?? '',
    recordedAt: iso(act.recordedAt),
    nextStepDate: act.nextStepDate ?? '',
  };
}

export function presentAssignment(view: AssignmentView): recoveryV1.PartnerAssignment {
  const assignment = view.assignment;
  return {
    id: assignment.id,
    caseId: assignment.caseId,
    caseNumber: view.caseNumber,
    partner: presentPartnerRef(view.partner),
    status: assignment.status,
    assignedAt: iso(assignment.assignedAt),
    withdrawnAt: iso(assignment.withdrawnAt),
    withdrawalReason: assignment.withdrawReason ?? '',
    acts: view.acts.map(presentAct),
    lastUpdateAt: iso(assignment.lastUpdateAt),
  };
}

export function presentPartner(view: PartnerView): recoveryV1.Partner {
  const { partner, stats } = view;
  const closed = stats.closedAssignments > 0;
  return {
    id: partner.id,
    kind: partner.kind,
    name: partner.name,
    office: partner.office ?? '',
    communeKeys: partner.areas,
    phones: partner.phones,
    email: partner.email ?? '',
    userId: partner.userId ?? '',
    fees: partner.fees.map((fee) => ({ actType: fee.actType, amount: money(fee.amount) })),
    status: partner.status,
    verificationFileId: partner.verificationFileId ?? '',
    verifiedBy: partner.verifiedBy
      ? { type: 'staff', userId: partner.verifiedBy, displayName: view.verifiedByName }
      : undefined,
    verifiedAt: iso(partner.verifiedAt),
    averageDelayDays: stats.averageDays ?? -1,
    successRateBps: closed
      ? successRateBp({ ...stats, id: partner.id, kind: partner.kind, status: partner.status, areas: [] })
      : -1,
    openAssignments: stats.openAssignments,
    createdAt: iso(partner.createdAt),
  };
}

/** Saisie d'une fiche partenaire du contrat ; absente : null. */
export function partnerInputOf(input: recoveryV1.PartnerInput | undefined): PartnerInputData | null {
  if (!input) return null;
  return {
    kind: input.kind,
    name: input.name,
    office: input.office,
    communeKeys: input.communeKeys,
    phones: input.phones,
    email: input.email,
    userId: input.userId,
    fees: input.fees.map((fee) => ({ actType: fee.actType, amount: amountOf('input.fees', fee.amount) })),
    verificationFileId: input.verificationFileId,
  };
}

/**
 * Dossier prêt du partenaire (R-HU-03) : débiteurs et coordonnées, créances, montants et créancier de
 * la fiche, seules pièces visibles du partenaire, échéancier signé, mises en demeure.
 */
export function presentAssignmentFile(file: AssignmentFileView): recoveryV1.AssignmentFile {
  const card = presentCase(file.caseView);
  return {
    assignment: presentAssignment(file.assignment),
    debtors: card.debtors,
    claims: card.claims,
    amounts: card.amounts,
    documents: file.documents.map((document) => presentDocument(document)),
    signedPlan: file.signedPlan ? presentPlan(file.signedPlan) : undefined,
    notices: file.notices.map(presentNotice),
    creditor: card.creditor,
  };
}
