import { type RecoveryEventPayloads, type RecoveryEventType } from '@ksp/contracts';
import { type LocalDay } from '../../domain/calendar';
import {
  type CaseKind,
  type CaseStage,
  type CaseStatus,
  type ClosureReason,
  type RejectionReason,
  type SkipReason,
} from '../../domain/case';
import { type ClaimNature } from '../../domain/eligibility';
import {
  type ImportLineError,
  type ImportLineStatus,
  type ImportLineValues,
  type ImportRow,
} from '../../domain/import';
import { type PlanScale } from '../../domain/payment-plan';
import { type ScoreBreakdown, type ScoreInput } from '../../domain/score';
import { type Holder } from '../ports';

/**
 * Ports des dossiers (lot R2, réutilisés par R3 à R5) : dépôt du dossier et de ses débiteurs, créances,
 * démarches et pièces ; lectures du créancier et du back-office ; imports ; préférences du créancier.
 * Les coordonnées des débiteurs circulent ici en clair : l'adaptateur de la base les chiffre et calcule
 * leurs empreintes (ADR-063). Chaque écriture porte ses entrées du journal de preuve, ses événements
 * (outbox), ses traces d'audit et ses changements d'étape, enregistrés dans la même transaction.
 */

export type CaseSource = 'form' | 'import' | 'rental';
export type DebtorKind = 'person' | 'company';
export type DebtorRole = 'main' | 'co_debtor' | 'guarantor';
export type ContactChannel = 'phone' | 'email';

/** Téléphone (E.164) ou e-mail d'un débiteur ; le premier de chaque canal est le principal. */
export interface DebtorContactData {
  id: string;
  channel: ContactChannel;
  value: string;
  isPrimary: boolean;
  valid: boolean;
}

export interface DebtorData {
  id: string;
  kind: DebtorKind;
  role: DebtorRole;
  firstNames: string | null;
  lastName: string | null;
  legalName: string | null;
  ifu: string | null;
  rccm: string | null;
  representativeName: string | null;
  address: string | null;
  communeKey: string | null;
  contacts: DebtorContactData[];
}

/** Créance : une facture ou une autre référence ; `paidBefore` = paiements reçus avant l'envoi. */
export interface ClaimData {
  id: string;
  reference: string;
  nature: ClaimNature;
  principal: number;
  dueDate: LocalDay;
  description: string | null;
  paidBefore: number;
}

/** Démarches déjà faites par le créancier (4.1, étape 5). */
export interface PriorEffortData {
  remindersCount: number;
  lastReminderDate: LocalDay | null;
  channels: string[];
  acknowledged: boolean;
  acknowledgmentFileId: string | null;
  promises: string | null;
}

/** Qui agit, dans le journal de preuve : `agent` désigne tout membre du personnel de KSP. */
export type EvidenceActorType = 'creditor' | 'debtor' | 'agent' | 'partner' | 'system';

export interface EvidenceActor {
  type: EvidenceActorType;
  id: string | null;
}

/** Pièce du dossier : fichier de file (justificatif) ou document produit par document (mandat…). */
export interface CaseDocumentData {
  id: string;
  kind: string;
  label: string;
  fileId: string | null;
  documentId: string | null;
  visibleToPartner: boolean;
  visibleToDebtor: boolean;
  addedBy: EvidenceActor;
  addedAt: Date;
}

/** Règles tarifaires figées à la préparation du mandat (R-CO-02, ADR-062). */
export interface FrozenPricing {
  feeRuleId: string;
  feeRuleVersion: number;
  commissionRuleId: string;
  commissionRuleVersion: number;
  commissionSummary: string;
  studyFeeRuleId: string | null;
  studyFeeRuleVersion: number | null;
}

/**
 * Frais de dossier (R-SD-04) : un débit du portefeuille prépayé pour la totalité. Un dossier refusé ou
 * classé est remboursé de ce débit en entier, puis débité du forfait d'étude ; chaque étape garde sa
 * transaction, pour être reprise par la tâche des échéances tant qu'elle n'a pas abouti.
 */
export interface CaseFeeState {
  amount: number;
  studyFee: number;
  /** Débit demandé à wallet sans réponse connue (panne) : la tâche le rapproche avant toute suppression. */
  debitAttemptedAt: Date | null;
  paidAt: Date | null;
  debitTransactionId: string | null;
  refundTransactionId: string | null;
  refundedAt: Date | null;
  studyFeeTransactionId: string | null;
  studyFeeChargedAt: Date | null;
}

export interface MandateState {
  documentId: string;
  signatureRequestId: string | null;
  signedAt: Date | null;
}

/** Score de recouvrabilité (R-SD-07) : note, détail par critère et valeurs retenues. */
export interface CaseScore {
  value: number;
  breakdown: ScoreBreakdown;
  inputs: ScoreInput;
  computedAt: Date;
}

/** Dossier complet (agrégat) : état, montants, parties, créances, pièces. */
export interface RecoveryCaseRecord {
  id: string;
  /** « RC-000123 », attribué par la séquence à la création. */
  number: string;
  kind: CaseKind;
  nature: ClaimNature;
  status: CaseStatus;
  stage: CaseStage | null;
  highestStage: CaseStage | null;
  creditor: Holder;
  createdBy: string;
  source: CaseSource;
  importId: string | null;
  /** Commune du débiteur principal (clé de geo) : tarification et filtres du back-office. */
  communeKey: string | null;
  preserveRelationship: boolean;
  /** Barème propre au dossier (saisi, ou copié des préférences du créancier) ; null : celui de KSP. */
  planScale: PlanScale | null;
  assignedAgentId: string | null;
  score: CaseScore | null;
  rejectionReason: RejectionReason | null;
  closureReason: ClosureReason | null;
  /** Motif écrit du complément demandé ou du refus, transmis au créancier. */
  reviewNote: string | null;
  /** Réponse du créancier au complément demandé. */
  completionNote: string | null;
  /** Clé de la dernière décision de recevabilité (rejeu d'AssessCase). */
  assessmentKey: string | null;
  mandate: MandateState | null;
  pricing: FrozenPricing | null;
  fee: CaseFeeState;
  /** Montants (R-SD-08) : dû = principal + intérêts + frais − payé. */
  principal: number;
  interests: number;
  costs: number;
  paid: number;
  earliestDueDate: LocalDay | null;
  prescriptionDate: LocalDay | null;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  infoRequestedAt: Date | null;
  lastActionAt: Date | null;
  /** Verrou optimiste : version lue, incrémentée à chaque enregistrement. */
  version: number;
  debtors: DebtorData[];
  claims: ClaimData[];
  priorEffort: PriorEffortData;
  documents: CaseDocumentData[];
}

/** Nature d'une entrée du journal (`JournalEntry.kind` du contrat). */
export type JournalKind =
  | 'contact'
  | 'message_sent'
  | 'letter'
  | 'promise'
  | 'payment'
  | 'plan'
  | 'decision'
  | 'stage_changed'
  | 'status_changed'
  | 'dispute'
  | 'document'
  | 'partner_act'
  | 'note'
  | 'system';

/**
 * Entrée du journal de preuve (R-PR-08), en ajout seul. Jamais de coordonnées du débiteur : le
 * résumé ne porte que des montants, des numéros et des faits.
 */
export interface EvidenceEntryData {
  id: string;
  caseId: string;
  occurredAt: Date;
  actor: EvidenceActor;
  /** Identifiant technique de l'action (`case.created`, `fee.paid`…). */
  action: string;
  kind: JournalKind;
  summary: string;
  channel: string | null;
  direction: 'inbound' | 'outbound' | null;
  outcome: string | null;
  deliveryStatus: string | null;
  amount: number | null;
  /** Entrée interne : jamais montrée au créancier ni au débiteur. */
  internal: boolean;
  /** Pièce liée : document (document) ou fichier (file). */
  ref: { type: 'document' | 'file'; id: string } | null;
}

/** Événement du contrat à publier par l'outbox. */
export type RecoveryOutboxMessage = {
  [K in RecoveryEventType]: { type: K; payload: RecoveryEventPayloads[K] };
}[RecoveryEventType];

/** Trace d'une action du back-office (en attendant le service audit). Identifiants et montants seulement. */
export interface CaseAuditEntry {
  actorId: string;
  action: string;
  entityType: 'recovery_case' | 'recovery_case_import';
  entityId: string;
  at: Date;
  details?: Record<string, unknown>;
}

/** Passage d'étape (historique du dossier, R-PR-03). */
export interface StageTransitionData {
  id: string;
  from: CaseStage | null;
  to: CaseStage;
  at: Date;
  by: EvidenceActor;
  reason: string | null;
  skipReason: SkipReason | null;
}

export interface CaseChanges {
  evidence: EvidenceEntryData[];
  events: RecoveryOutboxMessage[];
  audit: CaseAuditEntry[];
  stageTransitions: StageTransitionData[];
}

export const noChanges = (): CaseChanges => ({ evidence: [], events: [], audit: [], stageTransitions: [] });

/** Débiteur, contact et référence de créance cherchés parmi les dossiers ouverts (R-SD-06). */
export interface SimilarCaseProbe {
  phones: readonly string[];
  emails: readonly string[];
  references: readonly string[];
}

export type SaveOutcome = 'saved' | 'stale' | 'duplicate';

export interface CaseRepository {
  find(id: string): Promise<RecoveryCaseRecord | null>;
  findByIdempotencyKey(creditor: Holder, key: string): Promise<RecoveryCaseRecord | null>;
  /**
   * Nouveau dossier, ses parties et ses pièces : numéro RC tiré de la séquence. `duplicate` : un dossier
   * existe déjà avec cet identifiant ou cette clé (envoi simultané).
   */
  create(record: RecoveryCaseRecord, changes: CaseChanges): Promise<RecoveryCaseRecord | 'duplicate'>;
  /**
   * Enregistre l'état si la version n'a pas changé depuis la lecture (`stale` sinon). `content` :
   * débiteurs, créances et démarches remplacés (brouillon modifié). `inbox` : événement reçu marqué
   * traité dans la même transaction (`duplicate` s'il l'était déjà).
   */
  save(
    record: RecoveryCaseRecord,
    changes: CaseChanges,
    options?: { content?: boolean; inbox?: { eventId: string; consumer: string } },
  ): Promise<SaveOutcome>;
  /**
   * Supprime un dossier jamais payé (R-SD-04), avec ses parties, ses pièces et son journal, si sa
   * version n'a pas changé ; la trace d'audit reste.
   */
  deleteUnpaid(record: RecoveryCaseRecord, audit: CaseAuditEntry): Promise<boolean>;
  /** Dossiers ouverts du créancier qui partagent un contact de débiteur et une référence de créance. */
  findSimilarOpen(
    creditor: Holder,
    probe: SimilarCaseProbe,
    excludeCaseId: string | null,
  ): Promise<CaseSummaryRecord[]>;
  /** Brouillons et dossiers à payer créés avant cette date (délai de paiement des frais dépassé). */
  listUnpaidCreatedBefore(before: Date, limit: number): Promise<RecoveryCaseRecord[]>;
  /** Dossiers en attente d'un complément demandé avant cette date. */
  listInfoRequestedBefore(before: Date, limit: number): Promise<RecoveryCaseRecord[]>;
  /** Dossiers refusés dont le remboursement ou le forfait d'étude reste à passer. */
  listPendingFeeSettlements(limit: number): Promise<RecoveryCaseRecord[]>;
}

/** Ligne d'une liste de dossiers : de quoi présenter le résumé et l'échéance suivante. */
export interface CaseSummaryRecord {
  id: string;
  number: string;
  kind: CaseKind;
  status: CaseStatus;
  stage: CaseStage | null;
  creditor: Holder;
  /** Nom affiché du débiteur principal, déchiffré. */
  debtorName: string;
  principal: number;
  interests: number;
  costs: number;
  paid: number;
  score: number | null;
  assignedAgentId: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  infoRequestedAt: Date | null;
  lastActionAt: Date | null;
}

export interface CaseListFilter {
  creditor?: Holder;
  statuses?: readonly CaseStatus[];
  stages?: readonly CaseStage[];
  kinds?: readonly CaseKind[];
  assignedAgentId?: string;
  creditorId?: string;
  partnerId?: string;
  communeKey?: string;
  /** Numéro « RC-000123 », en tout ou en partie. */
  number?: string;
  /** Mots du nom du débiteur, normalisés (`nameTokens`) : recherche exacte par empreinte. */
  debtorNameTokens?: readonly string[];
  /** Dernière action au plus tard à cette date (dossiers sans action). */
  idleSince?: Date;
  /** Prescription au plus tard ce jour. */
  prescriptionBefore?: LocalDay;
}

export interface PageRequest {
  limit: number;
  cursor: string | null;
}

/** Chiffres du tableau de bord du créancier (14.1). */
export interface CreditorDashboardFigures {
  /** Montant confié : dû à l'envoi des dossiers envoyés, hors refusés. */
  entrusted: number;
  /** Encaissé (hors trop-perçu). */
  recovered: number;
  /** Dû des dossiers en cours. */
  outstanding: number;
  casesByStage: { stage: CaseStage; count: number }[];
  pendingDecisions: number;
  upcomingInstallments: {
    caseId: string;
    caseNumber: string;
    debtorName: string;
    dueDate: LocalDay;
    amount: number;
  }[];
}

/** Périmètre d'une lecture du back-office : un chargé seul ne voit que ses dossiers. */
export interface StaffScope {
  agentId: string | null;
  communeKey: string | null;
}

/** Chiffres du tableau de bord du recouvrement (14.6). */
export interface OverviewFigures {
  casesByStage: { stage: string; count: number }[];
  casesByKind: { stage: string; count: number }[];
  entrusted: number;
  recovered: number;
  /** Encaissé par groupe d'étapes de commission (amiable, mise en demeure, contentieux). */
  recoveredByStageGroup: { stage: string; amount: number }[];
  agents: { agentId: string; openCases: number; entrusted: number; recovered: number }[];
  installmentsDueToday: number;
  promisesToCheck: number;
  idleCases: number;
  prescriptionsNear: number;
  reviewQueue: number;
  offlinePaymentsToApprove: number;
}

export interface CaseQueries {
  list(
    filter: CaseListFilter,
    page: PageRequest,
  ): Promise<{ items: CaseSummaryRecord[]; nextCursor: string | null; total: number }>;
  /** Journal du dossier, le plus récent d'abord ; sans les entrées internes sauf demande. */
  journal(
    caseId: string,
    options: { includeInternal: boolean },
    page: PageRequest,
  ): Promise<{ items: EvidenceEntryData[]; nextCursor: string | null }>;
  stageHistory(caseId: string): Promise<StageTransitionData[]>;
  creditorDashboard(creditor: Holder, today: LocalDay): Promise<CreditorDashboardFigures>;
  overview(
    scope: StaffScope,
    today: LocalDay,
    options: { idleSince: Date; prescriptionBefore: LocalDay },
  ): Promise<OverviewFigures>;
}

/** Ligne d'un import : valeurs lues (chiffrées en base), statut, erreurs, dossier créé. */
export interface ImportLineRecord {
  row: number;
  values: ImportLineValues;
  status: ImportLineStatus;
  errors: ImportLineError[];
  caseId: string | null;
}

export type CaseImportStatus = 'checked' | 'confirmed' | 'expired';

export interface CaseImportRecord {
  id: string;
  creditor: Holder;
  createdBy: string;
  kind: 'b2b' | 'b2c';
  fileId: string;
  evidenceArchiveFileId: string | null;
  status: CaseImportStatus;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  lines: ImportLineRecord[];
}

export interface CaseImportRepository {
  find(id: string): Promise<CaseImportRecord | null>;
  findByIdempotencyKey(creditor: Holder, key: string): Promise<CaseImportRecord | null>;
  create(record: CaseImportRecord): Promise<'created' | 'duplicate'>;
  /** Lignes et compteurs, si la version n'a pas changé. */
  saveLines(record: CaseImportRecord): Promise<boolean>;
  /**
   * Confirmation : brouillons créés (numéros RC de la séquence), lignes rattachées à leur dossier et
   * import confirmé, dans une seule transaction, si la version n'a pas changé.
   */
  confirm(
    record: CaseImportRecord,
    cases: readonly { record: RecoveryCaseRecord; changes: CaseChanges }[],
  ): Promise<RecoveryCaseRecord[] | 'stale'>;
}

/** Préférences du créancier (14.1) : barèmes par défaut de ses nouveaux dossiers, comptes à prévenir. */
export interface CreditorPreferences {
  b2bScale: PlanScale | null;
  b2cScale: PlanScale | null;
  notifyUserIds: string[];
}

export interface StoredCreditorPreferences extends CreditorPreferences {
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface CreditorPreferencesStore {
  get(creditor: Holder): Promise<StoredCreditorPreferences | null>;
  save(creditor: Holder, preferences: CreditorPreferences, by: string, at: Date): Promise<void>;
}

/** Identité du créancier imprimée sur le mandat (identity : compte ou organisation). */
export interface CreditorProfile {
  name: string;
  kind: 'individual' | 'company';
  /** IFU ou RCCM d'une organisation. */
  identification: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  /** Organisation : membre qui signe pour elle. */
  representative: string | null;
}

export interface CreditorProfiles {
  profile(creditor: { holder: Holder; userId: string }): Promise<CreditorProfile>;
}

/**
 * Lecture d'un tableur d'import envoyé par file (finalité `recovery_import`) : lignes de données dans
 * l'ordre du modèle, en-tête exclue. Fichier illisible ou hors modèle : RECOVERY_IMPORT_FILE_INVALID.
 */
export interface SpreadsheetReader {
  read(input: {
    fileId: string;
    subject: { type: string; id: string };
    ownerId: string;
  }): Promise<ImportRow[]>;
}
