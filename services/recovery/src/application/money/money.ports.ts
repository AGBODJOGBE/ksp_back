import { type CaseStage, type StageGroup } from '../../domain/case';
import {
  type CollectionSource,
  type CommissionSettlement,
  type CommissionTotals,
} from '../../domain/collection';
import { type DisputeReason, type DisputeResolution, type DisputeStatus } from '../../domain/dispute';
import { type OfflinePaymentSource, type OfflinePaymentStatus } from '../../domain/offline-payment';
import {
  type CaseChanges,
  type CaseDocumentData,
  type EvidenceActor,
  type PageRequest,
  type RecoveryCaseRecord,
  type SaveOutcome,
} from '../cases/ports';
import { type Holder } from '../ports';

/**
 * Ports de l'argent et de l'espace du débiteur (lot R3, réutilisés par R4, R5 et billing) :
 * encaissements, liens de paiement demandés par le débiteur, paiements hors ligne à valider à deux,
 * trop-perçus remboursés, contestations, demandes de rappel, clôture. Toute écriture qui change le
 * dossier passe par `commit`, sous le verrou optimiste du dossier, avec son journal, ses événements
 * et son audit dans la même transaction.
 */

/** Moyen imprimé sur le reçu du débiteur (modèle `recovery_receipt` de document). */
export type ReceiptMethod = 'mobile_money' | 'card' | 'bank_transfer' | 'cash';

/** Encaissement imputé (table `collections`), lu aussi par R4 pour suivre les échéances. */
export interface CollectionRecord {
  id: string;
  caseId: string;
  source: CollectionSource;
  /** Référence d'idempotence, unique : `payment:<id>`, `offline:<id>`, `direct:<id>`. */
  reference: string;
  gross: number;
  allocatedCosts: number;
  allocatedInterests: number;
  allocatedPrincipal: number;
  overpaid: number;
  commissionBase: number;
  commission: number;
  /** Net crédité au créancier (0 pour un paiement direct). */
  net: number;
  settlement: CommissionSettlement;
  stage: CaseStage | null;
  stageGroup: StageGroup;
  /** Montant dû juste avant l'encaissement (imprimé sur le reçu). */
  dueBefore: number;
  rule: { id: string; version: number } | null;
  walletTransactionId: string | null;
  creditedAt: Date | null;
  /** Reçu à remettre au débiteur ; null : aucun (paiement direct, rien d'imputé). */
  receipt: { method: ReceiptMethod; reference: string } | null;
  receiptDocumentId: string | null;
  proofFileId: string | null;
  note: string | null;
  /** Compte qui a déclaré (créancier) ou validé (finance) l'encaissement ; null pour un lien payé. */
  recordedBy: string | null;
  /** Réception de l'argent. */
  collectedAt: Date;
  createdAt: Date;
}

/** Part du créancier confiée à wallet : brut hors trop-perçu, rien pour un paiement direct. */
export function creditedGross(
  collection: Pick<CollectionRecord, 'gross' | 'overpaid' | 'settlement'>,
): number {
  return collection.settlement === 'invoiced' ? 0 : collection.gross - collection.overpaid;
}

export type PaymentRequestStatus = 'active' | 'paid' | 'revoked' | 'expired';

/** Montant à payer par lien (ADR-060, point 7) : objet payable `recovery_payment_request`. */
export interface PaymentRequestRecord {
  id: string;
  caseId: string;
  debtorId: string | null;
  amount: number;
  status: PaymentRequestStatus;
  paymentLinkId: string | null;
  paymentUrl: string | null;
  requestedBy: 'debtor' | 'staff';
  /** Échéance payée par ce lien (R4), null pour un montant libre. */
  installmentId: string | null;
  /** Remise pour paiement immédiat payée par ce lien (R4, `SettlementTerms`). */
  settlementId: string | null;
  idempotencyKey: string | null;
  expiresAt: Date;
  paidAt: Date | null;
  createdAt: Date;
}

/** Somme reçue hors ligne, à valider par une deuxième personne (table `offline_payments`). */
export interface OfflinePaymentRecord {
  id: string;
  caseId: string;
  source: OfflinePaymentSource;
  amount: number;
  receivedAt: Date;
  /** Référence du virement ou du reçu de caisse. */
  reference: string | null;
  proofFileId: string | null;
  note: string | null;
  recordedBy: string;
  /** Partenaire déclarant et son assignation (R-HU-05, R5). */
  partnerId: string | null;
  assignmentId: string | null;
  status: OfflinePaymentStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  collectionId: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface OfflinePaymentFilter {
  statuses: readonly OfflinePaymentStatus[];
  caseId: string | null;
  /** Chargé seul : paiements de ses dossiers. */
  assignedAgentId: string | null;
}

export interface OverpaymentRefundRecord {
  id: string;
  caseId: string;
  amount: number;
  reference: string;
  note: string | null;
  recordedBy: string;
  idempotencyKey: string;
  recordedAt: Date;
}

/** Contestation du débiteur (R-PR-02) ; son texte circule en clair ici, chiffré en base (ADR-063). */
export interface DisputeRecord {
  id: string;
  caseId: string;
  debtorId: string | null;
  reason: DisputeReason;
  text: string | null;
  fileIds: string[];
  status: DisputeStatus;
  openedAt: Date;
  creditorAnswerDueAt: Date;
  creditorAnsweredAt: Date | null;
  resolution: DisputeResolution | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  idempotencyKey: string | null;
}

/** Rappel demandé par le débiteur (partie 7) ; son message est chiffré en base. */
export interface CallbackRecord {
  id: string;
  caseId: string;
  debtorId: string;
  slotStart: Date;
  slotEnd: Date;
  message: string | null;
  status: 'pending' | 'done' | 'missed' | 'cancelled';
  createdAt: Date;
}

/** Clôture du dossier (R-PR-10), à côté de son statut et de son motif. */
export interface ClosureRecord {
  closedAt: Date;
  closedBy: EvidenceActor;
  note: string | null;
  /** Attestation de solde (dossier payé), produite par les effets de la clôture. */
  certificateDocumentId: string | null;
  /** Effets terminés (attestation, liens révoqués, recovery.case.closed) ; null : à reprendre. */
  completedAt: Date | null;
}

/** Argent d'un dossier : cumuls de commission, imputations, trop-perçu, clôture. */
export interface CaseMoney {
  totals: CommissionTotals;
  /** Imputé par les encaissements (sans les paiements reçus avant l'envoi). */
  collected: { costs: number; interests: number; principal: number };
  /** Trop-perçu reçu, et déjà remboursé par la finance. */
  overpaid: number;
  refunded: number;
  closure: ClosureRecord | null;
}

/** Écritures liées au changement d'un dossier, dans la transaction de son état. */
export interface MoneyWrites {
  totals?: CommissionTotals;
  closure?: ClosureRecord;
  collections?: CollectionRecord[];
  /** Créées ou mises à jour (statut, paiement). */
  paymentRequests?: PaymentRequestRecord[];
  offlinePayments?: OfflinePaymentRecord[];
  refunds?: OverpaymentRefundRecord[];
  disputes?: DisputeRecord[];
  callbacks?: CallbackRecord[];
}

/** Encaissement crédité au créancier (`Remittance` du contrat). */
export interface RemittanceRecord {
  collection: CollectionRecord;
  caseNumber: string;
}

export interface RemittanceFilter {
  caseId: string | null;
  /** Bornes de `creditedAt`, incluses. */
  from: Date | null;
  to: Date | null;
}

export interface MoneyStore {
  money(caseId: string): Promise<CaseMoney>;
  /**
   * Enregistre le dossier si sa version n'a pas changé (`stale` sinon), ses pièces nouvelles, les
   * écritures liées, le journal, les événements et l'audit, dans une seule transaction. `inbox` :
   * événement reçu marqué traité dans la même transaction (`duplicate` s'il l'était déjà).
   */
  commit(
    record: RecoveryCaseRecord,
    writes: MoneyWrites,
    changes: CaseChanges,
    options?: { inbox?: { eventId: string; consumer: string } },
  ): Promise<SaveOutcome>;
  /** Marque l'événement traité sans rien changer (lien inconnu, déjà enregistré). */
  markProcessed(inbox: { eventId: string; consumer: string }): Promise<void>;

  collection(id: string): Promise<CollectionRecord | null>;
  collectionByReference(reference: string): Promise<CollectionRecord | null>;
  collections(caseId: string): Promise<CollectionRecord[]>;
  /**
   * Net crédité par wallet : transaction et date posées si l'encaissement ne l'était pas encore,
   * avec le journal et `recovery.remittance.paid` ; false s'il l'était déjà.
   */
  markCredited(
    collectionId: string,
    walletTransactionId: string,
    at: Date,
    changes: CaseChanges,
  ): Promise<boolean>;
  /** Reçu produit : rattaché à l'encaissement et ajouté aux pièces du dossier ; false s'il l'était déjà. */
  attachReceipt(collectionId: string, document: CaseDocumentData, changes: CaseChanges): Promise<boolean>;
  /** Encaissements dont le crédit ou le reçu reste à faire (tâche de reprise). */
  pendingSettlements(limit: number): Promise<CollectionRecord[]>;

  /**
   * Effets de la clôture terminés : attestation ajoutée aux pièces, liens de paiement révoqués, date
   * posée, événements et journal écrits, si elle ne l'était pas encore ; false sinon.
   */
  completeClosure(
    caseId: string,
    input: { at: Date; certificate: CaseDocumentData | null; revokedRequestIds: readonly string[] },
    changes: CaseChanges,
  ): Promise<boolean>;
  /** Dossiers clos dont les effets de la clôture restent à faire. */
  pendingClosures(limit: number): Promise<string[]>;

  paymentRequest(id: string): Promise<PaymentRequestRecord | null>;
  paymentRequestByKey(caseId: string, key: string): Promise<PaymentRequestRecord | null>;
  activePaymentRequests(caseId: string): Promise<PaymentRequestRecord[]>;

  offlinePayment(id: string): Promise<OfflinePaymentRecord | null>;
  offlinePaymentByKey(recordedBy: string, key: string): Promise<OfflinePaymentRecord | null>;
  listOfflinePayments(
    filter: OfflinePaymentFilter,
    page: PageRequest,
  ): Promise<{ items: (OfflinePaymentRecord & { caseNumber: string })[]; nextCursor: string | null }>;

  refundByKey(recordedBy: string, key: string): Promise<OverpaymentRefundRecord | null>;

  disputes(caseId: string): Promise<DisputeRecord[]>;
  disputeByKey(caseId: string, key: string): Promise<DisputeRecord | null>;

  /** Demandes de rappel encore en attente d'un dossier. */
  pendingCallbacks(caseId: string): Promise<CallbackRecord[]>;

  remittances(
    creditor: Holder,
    filter: RemittanceFilter,
    page: PageRequest,
  ): Promise<{ items: RemittanceRecord[]; nextCursor: string | null }>;
}
