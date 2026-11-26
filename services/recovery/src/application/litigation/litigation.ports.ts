import { type LocalDay } from '../../domain/calendar';
import {
  type FeeLine,
  type LegalActType,
  type NoticeDeliveryMethod,
  type PaidStage,
} from '../../domain/litigation';
import { type PartnerKind, type PartnerStatus } from '../../domain/partner';
import { type AmicableStore, type DecisionRecord, type RowWrite } from '../amicable/amicable.ports';
import {
  type CaseChanges,
  type EvidenceEntryData,
  type PageRequest,
  type RecoveryCaseRecord,
  type SaveOutcome,
} from '../cases/ports';
import { type MoneyDeps } from '../money/money-rules';

/**
 * Ports du contentieux (lot R5) : mise en demeure et journal de preuve exporté (courriers produits par
 * document), devis des étapes payantes et provisions du créancier, référentiel des huissiers et
 * avocats, assignations et actes. Le dossier reste l'agrégat du lot R2 : une action du contentieux
 * s'écrit sous son verrou optimiste (ou sa dernière action), avec ses lignes, les décisions du lot R4
 * qu'elle ouvre ou tranche, le journal de preuve, l'outbox et l'audit, dans une seule transaction.
 */

/** Honoraire convenu d'un partenaire : type d'acte (`LegalActType`), « hourly » ou « flat_case ». */
export interface PartnerFeeData {
  actType: string;
  amount: number;
}

/** Huissier ou avocat (R-HU-01). Coordonnées professionnelles chiffrées en base. */
export interface PartnerRecord {
  id: string;
  kind: PartnerKind;
  name: string;
  office: string | null;
  /** Ressort : clés de commune de geo. */
  areas: string[];
  phones: string[];
  email: string | null;
  /** Compte KSP de l'accès partenaire (rôle `recovery_bailiff` ou `recovery_lawyer`). */
  userId: string | null;
  fees: PartnerFeeData[];
  status: PartnerStatus;
  statusReason: string | null;
  verificationFileId: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  /** Verrou optimiste de la fiche : date de la dernière modification lue. */
  updatedAt: Date;
}

/** Charge et efficacité observées, calculées sur les assignations (R-HU-01, R-HU-02). */
export interface PartnerStats {
  openAssignments: number;
  /** Missions terminées (dossier clos), et parmi elles celles recouvrées (payé, accord exécuté). */
  closedAssignments: number;
  successfulAssignments: number;
  /** Durée moyenne d'une mission terminée, en jours ; null sans historique. */
  averageDays: number | null;
}

export type AssignmentStatus = 'active' | 'withdrawn' | 'completed';
export const ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['active', 'withdrawn', 'completed'];

/** Dossier confié à un partenaire (R-HU-02 à 07) ; retiré ou terminé, l'historique reste. */
export interface AssignmentRecord {
  id: string;
  caseId: string;
  partnerId: string;
  status: AssignmentStatus;
  assignedBy: string;
  assignedAt: Date;
  note: string | null;
  /** Devis accepté par le créancier pour ce partenaire, s'il y en a un. */
  quoteDocumentId: string | null;
  /** Dernière nouvelle du partenaire (acte, encaissement déclaré) : alerte au-delà de 15 jours. */
  lastUpdateAt: Date;
  withdrawnAt: Date | null;
  withdrawReason: string | null;
  completedAt: Date | null;
}

/** Acte d'un partenaire (R-HU-04) : sommation, signification, saisie, audience, décision… */
export interface LegalActRecord {
  id: string;
  assignmentId: string;
  caseId: string;
  type: LegalActType;
  actDate: LocalDay;
  cost: number;
  fileId: string | null;
  note: string | null;
  nextStepDate: LocalDay | null;
  /** Compte du partenaire qui l'a enregistré. */
  recordedBy: string;
  recordedAt: Date;
}

/** Courrier produit par document : mise en demeure (étape 4), partie d'un journal de preuve exporté. */
export type NoticeKind = 'formal_notice' | 'evidence_log';

export interface NoticeRecord {
  id: string;
  caseId: string;
  kind: NoticeKind;
  documentId: string;
  documentNumber: string;
  /** Juriste qui l'a produite et signée (mise en demeure), ou membre qui a exporté le journal. */
  signedBy: string | null;
  issuedAt: Date;
  /** Délai laissé au débiteur après la remise (mise en demeure). */
  deadlineDays: number | null;
  deliveryMethod: NoticeDeliveryMethod | null;
  deliveredAt: Date | null;
  deliveredBy: string | null;
  proofFileId: string | null;
  /** Fin du délai, comptée de la remise. */
  deadlineAt: Date | null;
}

/** Statut d'un courrier : produit (`issued`) puis remis (`delivered`). */
export const noticeStatus = (notice: Pick<NoticeRecord, 'deliveredAt'>) =>
  notice.deliveredAt ? 'delivered' : 'issued';

export type FeeQuoteStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

/** Devis des frais d'une étape payante (R-PR-04), soumis au créancier par une décision. */
export interface FeeQuoteRecord {
  id: string;
  caseId: string;
  decisionId: string;
  stage: PaidStage;
  partnerId: string;
  lines: FeeLine[];
  total: number;
  /** Provision débitée du portefeuille prépayé à l'acceptation : le total (ADR-060, point 10). */
  provision: number;
  documentId: string;
  documentNumber: string;
  validUntil: Date;
  status: FeeQuoteStatus;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  answeredAt: Date | null;
}

/** Provision payée par le créancier, consommée par les frais des actes, rendue à la main pour le reste. */
export type ProvisionStatus = 'paid' | 'settled' | 'refunded';

export interface ProvisionRecord {
  id: string;
  caseId: string;
  feeQuoteId: string | null;
  decisionId: string | null;
  amount: number;
  consumed: number;
  status: ProvisionStatus;
  /** Débit du portefeuille prépayé chez wallet. */
  debitTransactionId: string;
  paidAt: Date;
}

/**
 * Lignes écrites par une action. `expected` : statut lu (assignation, devis, décision ; `issued` ou
 * `delivered` pour un courrier), montant consommé lu (provision), null pour une nouvelle ligne.
 */
export interface LitigationWrites {
  assignments: RowWrite<AssignmentRecord>[];
  acts: LegalActRecord[];
  notices: RowWrite<NoticeRecord>[];
  feeQuotes: RowWrite<FeeQuoteRecord>[];
  provisions: RowWrite<ProvisionRecord>[];
  decisions: RowWrite<DecisionRecord>[];
  /** Pièces du dossier rendues visibles du partenaire (R-AR-02, ADR-060 point 13). */
  partnerDocuments: string[];
}

export const noLitigationWrites = (): LitigationWrites => ({
  assignments: [],
  acts: [],
  notices: [],
  feeQuotes: [],
  provisions: [],
  decisions: [],
  partnerDocuments: [],
});

/**
 * Écriture d'une action : dossier sous verrou (étape, pièces) ou simple dernière action, changements
 * du lot R2 et lignes du contentieux. `stale` : le dossier ou une ligne a changé depuis la lecture,
 * rien n'est écrit.
 */
export interface LitigationCommit {
  record?: RecoveryCaseRecord;
  touch?: { caseId: string; at: Date };
  changes: CaseChanges;
  litigation: LitigationWrites;
}

/** Trace d'audit d'une fiche partenaire (création, modification, activation, suspension). */
export interface PartnerAudit {
  actorId: string;
  action: string;
  at: Date;
  details?: Record<string, unknown>;
}

export interface PartnerFilter {
  kind: PartnerKind | null;
  statuses: readonly PartnerStatus[];
  communeKey: string | null;
}

/** Assignation d'un partenaire avec le numéro de son dossier (listes). */
export type AssignmentListItem = AssignmentRecord & { caseNumber: string };

export interface LitigationStore {
  commit(commit: LitigationCommit): Promise<SaveOutcome>;
  /**
   * Fiche partenaire créée (`expectedUpdatedAt` null) ou modifiée si elle n'a pas changé depuis la
   * lecture, avec sa trace d'audit. `duplicate` : identifiant ou compte partenaire déjà pris.
   */
  savePartner(
    partner: PartnerRecord,
    expectedUpdatedAt: Date | null,
    audit: PartnerAudit,
  ): Promise<SaveOutcome>;

  partner(id: string): Promise<PartnerRecord | null>;
  partnerByUser(userId: string): Promise<PartnerRecord | null>;
  partners(
    filter: PartnerFilter,
    page: PageRequest,
  ): Promise<{ items: PartnerRecord[]; nextCursor: string | null }>;
  /** Partenaires actifs d'un métier (propositions). */
  activePartners(kind: PartnerKind): Promise<PartnerRecord[]>;
  partnerStats(partnerIds: readonly string[]): Promise<Map<string, PartnerStats>>;

  assignment(id: string): Promise<AssignmentRecord | null>;
  caseAssignments(caseId: string): Promise<AssignmentRecord[]>;
  assignmentsOf(
    partnerId: string,
    statuses: readonly AssignmentStatus[],
    page: PageRequest,
  ): Promise<{ items: AssignmentListItem[]; nextCursor: string | null }>;
  /** Actes des assignations, du plus ancien au plus récent. */
  acts(assignmentIds: readonly string[]): Promise<LegalActRecord[]>;
  act(id: string): Promise<LegalActRecord | null>;
  caseActs(caseId: string): Promise<LegalActRecord[]>;

  notice(id: string): Promise<NoticeRecord | null>;
  /** Courriers d'un dossier, du plus ancien au plus récent. */
  notices(caseId: string, kind: NoticeKind): Promise<NoticeRecord[]>;
  feeQuote(id: string): Promise<FeeQuoteRecord | null>;
  feeQuotes(caseId: string): Promise<FeeQuoteRecord[]>;
  provisions(caseId: string): Promise<ProvisionRecord[]>;

  /** Journal de preuve du dossier sans les entrées internes, du plus ancien au plus récent. */
  evidenceLog(caseId: string): Promise<EvidenceEntryData[]>;
  /** Dernier contact abouti avec le débiteur (joint, promesse, rappel demandé), null sans contact. */
  lastReachedContactAt(caseId: string): Promise<Date | null>;

  // Tâche du contentieux : lots triés par identifiant, repris après `afterId`.
  /** Dossiers actifs à la mise en demeure dont la dernière remise a son délai écoulé. */
  expiredNotices(now: Date, afterCaseId: string | null, limit: number): Promise<NoticeRecord[]>;
  /** Assignations actives sans nouvelle depuis `before`, dossier ouvert. */
  silentAssignments(before: Date, afterId: string | null, limit: number): Promise<AssignmentRecord[]>;
  /** Assignations encore actives d'un dossier clos ou refusé : mission à terminer. */
  assignmentsOfClosedCases(limit: number): Promise<AssignmentRecord[]>;
}

/** Dépendances du contentieux : celles de l'argent (R3), plus la procédure amiable (R4) et ses lignes. */
export interface LitigationDeps extends MoneyDeps {
  amicable: AmicableStore;
  litigation: LitigationStore;
}
