import { type recoveryV1 } from '@ksp/contracts';
import { type DebtorCaseView } from '../../application/debtor-space/debtor-space.use-cases';
import {
  type CollectionRecord,
  creditedGross,
  type DisputeRecord,
  type RemittanceRecord,
} from '../../application/money/money.ports';
import { type MoneyCaseView, type OfflinePaymentView } from '../../application/money/money-views';
import { localDay } from '../../domain/calendar';
import { actorOf, presentCase, presentPlanScale } from './case-presenters';
import { money } from './presenters';

/**
 * Traductions de l'argent et de l'espace du débiteur (lot R3) vers le contrat ksp.recovery.v1 :
 * encaissements, contestations, clôture, paiements hors ligne, reversements, situation du débiteur.
 * Le débiteur ne voit jamais les coordonnées des autres parties ni le détail des commissions.
 */

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : '');

export function presentCollection(collection: CollectionRecord): recoveryV1.Collection {
  return {
    id: collection.id,
    source: collection.source,
    gross: money(collection.gross),
    allocatedCosts: money(collection.allocatedCosts),
    allocatedInterests: money(collection.allocatedInterests),
    allocatedPrincipal: money(collection.allocatedPrincipal),
    overpaid: money(collection.overpaid),
    commission: money(collection.commission),
    netToCreditor: money(collection.net),
    stage: collection.stage ?? '',
    receivedAt: iso(collection.collectedAt),
    walletTransactionId: collection.walletTransactionId ?? '',
    receiptDocumentId: collection.receiptDocumentId ?? '',
  };
}

/** Contestation du contrat ; la réponse du créancier (décision `dispute_response`) arrive avec R4. */
export function presentDispute(dispute: DisputeRecord): recoveryV1.Dispute {
  return {
    id: dispute.id,
    reason: dispute.reason,
    text: dispute.text ?? '',
    fileIds: dispute.fileIds,
    status: dispute.status,
    openedAt: iso(dispute.openedAt),
    creditorAnswerDueAt: iso(dispute.creditorAnswerDueAt),
    creditorAnswer: '',
    creditorFileIds: [],
    resolutionNote: dispute.resolutionNote ?? '',
    resolvedAt: iso(dispute.resolvedAt),
  };
}

/** Fiche du dossier (R2) complétée de ses encaissements, contestations et clôture. */
export function presentMoneyCase(view: MoneyCaseView): recoveryV1.RecoveryCase {
  const record = view.view.record;
  return {
    ...presentCase(view.view),
    collections: view.collections.map(presentCollection),
    disputes: view.disputes.map(presentDispute),
    closure:
      view.closure && record.closureReason
        ? {
            reason: record.closureReason,
            note: view.closure.note ?? '',
            closedAt: iso(view.closure.closedAt),
            closedBy: actorOf(view.closure.closedBy, view.closedByName),
            settlementCertificateDocumentId: view.closure.certificateDocumentId ?? '',
          }
        : undefined,
  };
}

export function presentOfflinePayment(view: OfflinePaymentView): recoveryV1.OfflinePayment {
  const payment = view.payment;
  return {
    id: payment.id,
    caseId: payment.caseId,
    caseNumber: view.caseNumber,
    source: payment.source,
    amount: money(payment.amount),
    receivedOn: localDay(payment.receivedAt),
    reference: payment.reference ?? '',
    proofFileId: payment.proofFileId ?? '',
    status: payment.status,
    recordedBy: {
      type: payment.partnerId ? 'partner' : 'staff',
      userId: payment.recordedBy,
      displayName: view.recordedByName,
    },
    approvedBy:
      payment.status === 'approved' && payment.reviewedBy
        ? { type: 'staff', userId: payment.reviewedBy, displayName: view.reviewedByName }
        : undefined,
    rejectionReason: payment.rejectionReason ?? '',
    collectionId: payment.collectionId ?? '',
    createdAt: iso(payment.createdAt),
    partnerAssignmentId: payment.assignmentId ?? '',
  };
}

/** Reversement : part du créancier confiée à wallet, commission retenue, net crédité. */
export function presentRemittance(remittance: RemittanceRecord): recoveryV1.Remittance {
  const collection = remittance.collection;
  return {
    collectionId: collection.id,
    caseId: collection.caseId,
    caseNumber: remittance.caseNumber,
    source: collection.source,
    gross: money(creditedGross(collection)),
    commission: money(collection.commission),
    net: money(collection.net),
    creditedAt: iso(collection.creditedAt),
    walletTransactionId: collection.walletTransactionId ?? '',
  };
}

/** Situation du débiteur (partie 7) : son dossier seulement, le créancier par son nom. */
export function presentDebtorCase(view: DebtorCaseView): recoveryV1.DebtorCaseView {
  return {
    caseNumber: view.caseNumber,
    creditorName: view.creditorName,
    nature: view.nature,
    references: view.references,
    amounts: {
      principal: money(view.amounts.principal),
      interests: money(view.amounts.interests),
      costs: money(view.amounts.costs),
      paid: money(view.amounts.paid),
      waived: money(view.amounts.waived),
      due: money(view.amounts.due),
      overpaid: money(view.amounts.overpaid),
    },
    payments: view.payments.map((payment) => ({
      amount: money(payment.amount),
      paidAt: iso(payment.paidAt),
      channel: payment.channel,
      receiptDocumentId: payment.receiptDocumentId ?? '',
    })),
    documents: view.documents.map((document) => ({
      documentId: document.documentId ?? '',
      fileId: document.fileId ?? '',
      label: document.label,
      kind: document.kind,
    })),
    plan: undefined,
    settlementOffer: undefined,
    planScale: presentPlanScale(view.planScale),
    status: view.status,
    disputes: view.disputes.map(presentDispute),
    pendingPaymentUrl: view.pendingPaymentUrl,
    settlementCertificateDocumentId: view.certificateDocumentId,
  };
}
