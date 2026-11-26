import { type MessageChannel } from '../../domain/amicable';
import { type LocalDay } from '../../domain/calendar';
import { type CaseStage, type CaseStatus, type SkipReason } from '../../domain/case';
import { type DecisionAnswer, type DecisionKind, type DecisionStatus } from '../../domain/decision';
import {
  type InstallmentStatus,
  type PlanStatus,
  type PlanTerms,
  type ScaleViolation,
} from '../../domain/payment-plan';
import { type PromiseStatus } from '../../domain/promise';
import { type CaseDeps } from '../cases/creditor-cases.use-cases';
import {
  type CaseChanges,
  type CaseSummaryRecord,
  type EvidenceActor,
  type EvidenceEntryData,
  type PageRequest,
  type RecoveryCaseRecord,
  type SaveOutcome,
} from '../cases/ports';
import { type DebtorAccessPorts } from '../debtor-access/debtor-access.ports';
import { type MoneyStore } from '../money/money.ports';
import { type AuditLog, type DebtorChannel, type DebtorMessage, type Holder, type Notifier } from '../ports';

/**
 * Ports de la procédure amiable (lot R4) : contacts, promesses, échéanciers et leurs échéances,
 * décisions du créancier, remises, et file des messages automatiques au débiteur. Le dossier reste
 * l'agrégat du lot R2 : un changement d'étape passe par son verrou optimiste, dans la même transaction
 * que les lignes de la procédure, le journal de preuve, l'outbox et l'audit. Les encaissements (lot
 * R3) ne sont que lus, pour déduire l'état des échéances et des promesses.
 */

/** Canal d'un contact (`JournalEntry.channel`). */
export type ContactChannelKind = 'phone' | 'sms' | 'whatsapp' | 'email' | 'letter' | 'visit';

/** Résultat d'un contact (`JournalEntry.outcome`). */
export type ContactOutcome =
  | 'reached'
  | 'no_answer'
  | 'wrong_number'
  | 'refused'
  | 'promise'
  | 'callback_requested'
  | 'delivered'
  | 'failed';

/** Contact avec le débiteur (R-PR-08) : appel, message, courrier, visite, et rappel promis. */
export interface ContactRecord {
  id: string;
  caseId: string;
  debtorId: string | null;
  channel: ContactChannelKind;
  direction: 'inbound' | 'outbound';
  outcome: ContactOutcome | null;
  deliveryStatus: string | null;
  /** Note du chargé : jamais dans le journal de preuve, qui ne porte que des faits. */
  note: string | null;
  occurredAt: Date;
  by: EvidenceActor;
  internal: boolean;
  /** Rappel promis au débiteur (« Ma journée »), soldé par le contact sortant suivant. */
  callbackAt: Date | null;
  callbackDoneAt: Date | null;
  fileId: string | null;
}

/** Promesse de paiement (R-PR-09). */
export interface PromiseRecord {
  id: string;
  caseId: string;
  amount: number;
  dueDate: LocalDay;
  status: PromiseStatus;
  createdBy: string;
  note: string | null;
  keptAt: Date | null;
  brokenAt: Date | null;
  createdAt: Date;
}

export interface InstallmentRecord {
  id: string;
  rank: number;
  dueDate: LocalDay;
  amount: number;
  paidAmount: number;
  status: InstallmentStatus;
  paidAt: Date | null;
}

/**
 * Échéancier (6.1) et son protocole : proposé (en attente du superviseur s'il est hors barème, ou de la
 * signature du débiteur dès que `documentId` est posé), soumis au créancier, signé, soldé, rompu,
 * refusé ou annulé par une renégociation.
 */
export interface PlanRecord {
  id: string;
  caseId: string;
  status: PlanStatus;
  terms: PlanTerms;
  total: number;
  withinScale: boolean;
  violations: ScaleViolation[];
  /** Débiteur (son identifiant de débiteur) ou chargé (son compte). */
  proposedBy: { type: 'debtor' | 'agent'; id: string | null };
  /** Échéancier signé que celui-ci renégocie (une seule renégociation, 6.1). */
  renegotiatedFromId: string | null;
  /** Protocole d'accord en cours de signature (modèle `recovery_settlement_agreement`). */
  documentId: string | null;
  signatureRequestId: string | null;
  signatureSentAt: Date | null;
  signatureExpiresAt: Date | null;
  /** Envois du lien de signature : chaque renvoi produit un nouveau protocole. */
  signatureRound: number;
  signedAt: Date | null;
  endedAt: Date | null;
  /** Message du débiteur ou note du chargé avec la proposition. */
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** Verrou optimiste de l'échéancier et de ses échéances. */
  version: number;
  installments: InstallmentRecord[];
}

/** Objet d'une décision : échéancier, remise, saut d'étape (R-PR-03) ou contestation (R-PR-02). */
export interface DecisionPayload {
  planId?: string;
  settlementId?: string;
  disputeId?: string;
  skip?: { from: CaseStage; to: CaseStage; reason: SkipReason; note: string };
}

export interface DecisionAnswerData {
  answer: DecisionAnswer;
  comment: string | null;
  fileIds: string[];
  idempotencyKey: string | null;
}

/** Décision demandée au créancier (UC-RC-06, 07). */
export interface DecisionRecord {
  id: string;
  caseId: string;
  kind: DecisionKind;
  status: DecisionStatus;
  payload: DecisionPayload;
  requestedBy: string | null;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  answer: DecisionAnswerData | null;
}

/**
 * Remise pour paiement immédiat (R-PR-05) : proposée au débiteur (dans le barème), en attente du
 * créancier, acceptée par lui (alors offerte au débiteur), refusée, exécutée (paiement reçu, lot R3)
 * ou expirée.
 */
export type SettlementStatus =
  'proposed' | 'pending_creditor' | 'accepted' | 'rejected' | 'executed' | 'expired';

export interface SettlementRecord {
  id: string;
  caseId: string;
  payNow: number;
  waived: number;
  discountBps: number;
  validUntil: LocalDay;
  status: SettlementStatus;
  withinScale: boolean;
  proposedBy: string;
  note: string | null;
  createdAt: Date;
  answeredAt: Date | null;
}

/** Raison d'un message automatique ou manuel au débiteur. */
export type MessagePurpose =
  'notice' | 'amicable_step' | 'promise_followup' | 'installment_reminder' | 'plan_confirmed' | 'manual';

export type MessageStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

/**
 * Message au débiteur en file : envoyé par la tâche dans la plage de contact, hors jours fériés,
 * avec un lien personnel renouvelé à l'envoi. La clé de dédoublonnage rend chaque envoi unique (un
 * premier contact par dossier, un rappel par échéance…). Aucune coordonnée ni aucun nom ici : ils
 * sont lus dans le dossier au moment d'envoyer.
 */
export interface DebtorMessageRecord {
  id: string;
  caseId: string;
  debtorId: string;
  message: DebtorMessage;
  purpose: MessagePurpose;
  dedupeKey: string;
  /** Variables sans donnée personnelle (montant et jour d'une échéance). */
  variables: Record<string, string>;
  /** Objet concerné : échéance, promesse, échéancier, passage d'étape. */
  refId: string | null;
  /** Canal imposé (« e-mail » du pas courrier ou e-mail) ; null : ordre réglé du service. */
  channel: MessageChannel | null;
  notBefore: Date;
  status: MessageStatus;
  attempts: number;
  notificationId: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

/** Ligne écrite par un changement : `expected` = statut (ou version de l'échéancier) lu, null si nouvelle. */
export interface RowWrite<T> {
  row: T;
  expected: string | number | null;
}

export interface AmicableChanges {
  contacts: ContactRecord[];
  /** Rappels promis soldés : ceux du dossier prévus au plus tard à `until`. */
  callbacksDone: { caseId: string; until: Date; at: Date }[];
  promises: RowWrite<PromiseRecord>[];
  plans: RowWrite<PlanRecord>[];
  decisions: RowWrite<DecisionRecord>[];
  settlements: RowWrite<SettlementRecord>[];
  /** Nouveaux messages : ignorés si leur clé de dédoublonnage existe déjà. */
  messages: DebtorMessageRecord[];
  /** Messages mis à jour (envoyés, en échec, annulés). */
  messageUpdates: DebtorMessageRecord[];
}

export const noAmicableChanges = (): AmicableChanges => ({
  contacts: [],
  callbacksDone: [],
  promises: [],
  plans: [],
  decisions: [],
  settlements: [],
  messages: [],
  messageUpdates: [],
});

/**
 * Écriture d'une action : dossier sous verrou (étape, pièces) ou simple dernière action, changements
 * du lot R2 (journal, outbox, audit, étapes) et lignes de la procédure, dans une seule transaction.
 * `stale` : le dossier ou une ligne a changé depuis la lecture, rien n'est écrit. `duplicate` :
 * événement déjà traité (inbox).
 */
export interface AmicableCommit {
  record?: RecoveryCaseRecord;
  touch?: { caseId: string; at: Date };
  changes: CaseChanges;
  amicable: AmicableChanges;
  inbox?: { eventId: string; consumer: string };
}

/** Élément de « Ma journée » (`WorkItem.kind`). */
export type WorkItemKind =
  | 'promised_callback'
  | 'broken_promise'
  | 'missed_installment'
  | 'reminder_due'
  | 'callback_request'
  | 'dispute'
  | 'plan_to_validate';

export interface WorkQueueRow {
  kind: WorkItemKind;
  caseId: string;
  dueAt: Date;
  note: string;
}

/** Dossier en relance amiable : début de l'étape, contacts sortants depuis, pas déjà partis seuls. */
export interface AmicableFollowUp {
  caseId: string;
  transitionId: string;
  startedAt: Date;
  outboundContacts: { channel: ContactChannelKind; occurredAt: Date }[];
  automaticSteps: number[];
}

export interface DecisionListItem {
  decision: DecisionRecord;
  caseNumber: string;
}

export interface AmicableStore {
  commit(commit: AmicableCommit): Promise<SaveOutcome>;

  contact(id: string): Promise<ContactRecord | null>;
  promise(id: string): Promise<PromiseRecord | null>;
  plan(id: string): Promise<PlanRecord | null>;
  planByDocument(documentId: string): Promise<PlanRecord | null>;
  decision(id: string): Promise<DecisionRecord | null>;
  settlement(id: string): Promise<SettlementRecord | null>;
  evidence(id: string): Promise<EvidenceEntryData | null>;
  message(dedupeKey: string): Promise<DebtorMessageRecord | null>;
  /** Échéanciers du dossier, le plus récent d'abord. */
  plans(caseId: string): Promise<PlanRecord[]>;
  promises(caseId: string): Promise<PromiseRecord[]>;
  settlements(caseId: string): Promise<SettlementRecord[]>;
  pendingDecision(caseId: string, kind: DecisionKind): Promise<DecisionRecord | null>;
  /** Dernier passage d'étape du dossier. */
  stageStart(caseId: string): Promise<{ transitionId: string; stage: CaseStage; at: Date } | null>;
  hasEvidence(caseId: string, action: string, since: Date): Promise<boolean>;
  /** Encaissé (brut moins trop-perçu) depuis un instant : lecture seule des encaissements (lot R3). */
  collectedSince(caseId: string, since: Date): Promise<number>;

  // Tâche de la procédure amiable : lots triés par identifiant, repris après `afterId`.
  activeCases(stages: readonly CaseStage[], afterId: string | null, limit: number): Promise<string[]>;
  /** Dossiers actifs à l'étape de notification sans premier message en file. */
  casesWithoutNotice(limit: number): Promise<string[]>;
  signedPlans(afterId: string | null, limit: number): Promise<PlanRecord[]>;
  pendingPromises(
    afterId: string | null,
    limit: number,
  ): Promise<{ promise: PromiseRecord; caseStatus: CaseStatus }[]>;
  expiredDecisions(now: Date, limit: number): Promise<DecisionRecord[]>;
  expiredSettlements(today: LocalDay, limit: number): Promise<SettlementRecord[]>;
  /**
   * Messages à envoyer (`notBefore` atteint), réservés jusqu'à `leaseUntil` (SKIP LOCKED) : une autre
   * instance de la tâche ne les reprend qu'après ce délai.
   */
  claimMessages(now: Date, leaseUntil: Date, limit: number): Promise<DebtorMessageRecord[]>;

  // Lectures du back-office et du créancier
  /** Éléments de « Ma journée » prévus au plus tard à `until` ; `agentId` null : tous les dossiers. */
  workQueue(
    scope: { agentId: string | null; plansToValidate: boolean },
    until: Date,
  ): Promise<WorkQueueRow[]>;
  amicableFollowUps(agentId: string | null, limit: number): Promise<AmicableFollowUp[]>;
  summaries(caseIds: readonly string[]): Promise<CaseSummaryRecord[]>;
  decisionsOf(
    creditor: Holder,
    filter: { statuses: readonly DecisionStatus[]; caseId: string | null },
    page: PageRequest,
  ): Promise<{ items: DecisionListItem[]; nextCursor: string | null }>;
}

/** Annulation d'un document non signé chez document (renvoi du protocole d'échéancier). */
export interface DocumentCancellation {
  cancel(input: { documentId: string; reason: string }): Promise<void>;
}

/** Réglages du service pour les messages au débiteur (variables d'environnement). */
export interface AmicableOptions {
  /**
   * Ordre des canaux des messages automatiques au débiteur, premier contact compris : le premier dont
   * la coordonnée est connue sert, notification prend l'autre en repli.
   */
  debtorChannels: readonly DebtorChannel[];
}

/** Dépendances des cas d'usage de la procédure amiable : celles des dossiers, plus les leurs. */
export interface AmicableDeps extends CaseDeps {
  amicable: AmicableStore;
  audit: AuditLog;
  notifier: Notifier;
  debtorAccess: DebtorAccessPorts;
  documentCancellation: DocumentCancellation;
  amicableOptions: AmicableOptions;
  /** Contestations du débiteur (lot R3), lues pour la décision `dispute_response`. */
  money: Pick<MoneyStore, 'disputes'>;
}
