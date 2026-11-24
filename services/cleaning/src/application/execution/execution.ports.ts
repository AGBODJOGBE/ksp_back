import { type SessionPaymentStatus } from '../../domain/payments/payment-status';
import { type ActiveCause, type SuspensionCauseCode } from '../../domain/programs/suspension';
import { type ProgramStatus } from '../../domain/programs/program-status';
import { type SessionCancelCause } from '../../domain/payments/charge';
import { type Reschedule } from '../../domain/sessions/reschedule';
import { type FieldSession, type Incident, type MissedCause } from '../../domain/sessions/session';
import { type SessionStatus } from '../../domain/sessions/session-status';
import { type OrganizationTransaction } from '../organizations/organizations.ports';
import { type Changes } from '../ports';
import { type Page } from '../shared/input';

/**
 * Ports du lot E : programmes, séances sur le terrain, paiement par séance (parties 8, 10, 11, 12).
 * Les écritures passent par `transaction` : `lockProgram` y verrouille la ligne du programme avant
 * toute lecture de ses séances, ce qui sérialise les décisions d'un même programme (débit, retard,
 * suspension, reprise, arrêt). Chaque écriture porte ses événements et ses traces (`write`).
 */

export type OwnerKind = 'user' | 'organization';
export type PayerKind = 'individual' | 'organization';
export type PlanKind = 'one_off' | 'weekly' | 'monthly';

/** Demande d'arrêt par KSP en attente d'une deuxième personne (partie 12). */
export interface PendingCancellation {
  reason: string;
  requestedBy: string;
  requestedAt: Date;
}

export interface ProgramCleaningType {
  id: string;
  code: string;
  name: string;
  /** Points de la liste de contrôle du type (R-EX-09), dans l'ordre. */
  checklist: { code: string; label: string }[];
}

export interface ProgramRecord {
  id: string;
  number: string;
  requestId: string;
  requestNumber: string;
  quoteId: string;
  ownerKind: OwnerKind;
  ownerId: string;
  /** Compte du client : titulaire, ou auteur de la demande pour une organisation. */
  customerId: string;
  organizationId: string | null;
  payerKind: PayerKind;
  placeId: string;
  placeName: string;
  placeTypeId: string;
  placeTypeName: string;
  communeKey: string;
  communeName: string;
  status: ProgramStatus;
  causes: ActiveCause[];
  suspendedAt: Date | null;
  sessionPrice: number;
  teamSize: number;
  durationMinutes: number;
  schedulePlan: unknown;
  planKind: PlanKind;
  visitFeeToDeduct: number;
  sessionsCount: number;
  sessionsCompleted: number;
  firstSessionAt: Date | null;
  lastSessionAt: Date | null;
  cancelledAt: Date | null;
  cancelledBy: 'customer' | 'ksp' | null;
  cancellationReason: string | null;
  pendingCancellation: PendingCancellation | null;
  cleaningTypes: ProgramCleaningType[];
  createdAt: Date;
  version: number;
  // --- Piste P : renouvellement (R-PG-07) ---
  /** Programme que celui-ci renouvelle ; null pour le premier programme d'une demande. */
  renewalOfProgramId: string | null;
  /** Programme créé par le renouvellement de celui-ci ; null sinon. */
  renewedByProgramId: string | null;
  /** Proposition de renouvellement ; null : aucune. */
  renewal: ProgramRenewal | null;
}

/** Proposition de renouvellement d'un programme (contrat Renewal). */
export interface ProgramRenewal {
  status: 'proposed' | 'accepted' | 'declined';
  proposedAt: Date;
  /** Dernier devis de renouvellement ; null : nouvelle visite nécessaire, aucun devis. */
  quoteId: string | null;
  respondedAt: Date | null;
}

/** Agent affecté, avec l'état de son affectation (valeurs du contrat AssignedAgent.confirmation). */
export interface SessionAgent {
  assignmentId: string;
  agentId: string;
  userId: string;
  isLead: boolean;
  confirmation: 'confirmed' | 'pending' | 'proposed';
}

export interface SessionCancellationRecord {
  by: 'customer' | 'ksp';
  cause: SessionCancelCause;
  late: boolean;
  at: Date;
  reason: string | null;
}

export interface SessionRecord extends FieldSession {
  programId: string;
  rank: number;
  communeKey: string;
  price: number;
  amountDue: number | null;
  visitFeeDeducted: number;
  paymentStatus: SessionPaymentStatus | null;
  dueBy: Date | null;
  paidAt: Date | null;
  invoiceId: string | null;
  isRedo: boolean;
  /** Position chiffrée de l'arrivée (précisions comprises) ; jamais rendue telle quelle. */
  arrivalGpsEncrypted: string | null;
  agentDetails: SessionAgent[];
  cancellation: SessionCancellationRecord | null;
  reschedules: (Reschedule & { id: string })[];
  rating: { stars: number; comment: string | null; ratedAt: Date } | null;
  catchUpSuggestedStart: Date | null;
  remindedAt: Date | null;
  balanceAlertedAt: Date | null;
  staffingAlertLevel: 'unassigned_48h' | 'unassigned_at_start' | 'agent_absent' | null;
  claimIds: string[];
  openClaim: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** Changement d'une séance : seuls les champs présents sont écrits. */
export interface SessionPatch {
  status?: SessionStatus;
  scheduledStart?: Date;
  scheduledEnd?: Date;
  arrivedAt?: Date | null;
  arrivalGpsEncrypted?: string | null;
  arrivalDistanceM?: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  checklist?: FieldSession['checklist'];
  beforePhotoFileIds?: string[];
  afterPhotoFileIds?: string[];
  signatureFileId?: string | null;
  missed?: {
    cause: MissedCause;
    missedAt: Date;
    waitStartedAt: Date | null;
    calledAt: Date | null;
    photoFileId: string | null;
  };
  cancellation?: SessionCancellationRecord & { actorId: string | null };
  staffClosure?: { closedBy: string; reason: string; presentAgentIds: string[] };
  amountDue?: number | null;
  visitFeeDeducted?: number;
  paymentStatus?: SessionPaymentStatus | null;
  dueBy?: Date | null;
  paidAt?: Date | null;
  invoiceId?: string | null;
  catchUpSuggestedStart?: Date | null;
  remindedAt?: Date | null;
  balanceAlertedAt?: Date | null;
  rating?: { stars: number; comment: string | null; ratedAt: Date };
  staffingAlertLevel?: 'unassigned_48h' | 'unassigned_at_start' | 'agent_absent';
}

export interface ProgramPatch {
  status?: ProgramStatus;
  suspendedAt?: Date | null;
  visitFeeToDeduct?: number;
  completedAt?: Date | null;
  cancellation?: { at: Date; by: 'customer' | 'ksp'; reason: string | null; approvedBy: string | null };
  /** Demande d'arrêt par KSP (motif) ; null : demande retirée. */
  cancellationRequestReason?: string | null;
  // --- Piste P : vie du programme (R-PG-06) ---
  /** Nouveau plan des séances à venir (changement de plan, avenant). */
  schedulePlan?: unknown;
  durationMinutes?: number;
}

/** Opération de wallet enregistrée avant l'appel (15.4). */
export interface WalletOperationRecord {
  id: string;
  idempotencyKey: string;
  attempt: number;
  sessionId: string | null;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed';
  walletTransactionId: string | null;
  failureCode: string | null;
  createdAt: Date;
}

export interface DirectPaymentRecord {
  id: string;
  paymentRequestId: string | null;
  idempotencyKey: string;
  sessionId: string | null;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed' | 'expired' | 'left_in_wallet';
  checkoutUrl: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface ProgramFilter {
  ownerKind?: OwnerKind;
  ownerId?: string;
  status?: ProgramStatus | null;
  communeKey?: string | null;
  payerKind?: PayerKind | null;
  /** Numéro du programme (PN-…), recherche partielle. */
  q?: string | null;
}

/** Lectures communes au dépôt et à la transaction. */
export interface ExecutionReader {
  program(id: string): Promise<ProgramRecord | null>;
  session(id: string): Promise<SessionRecord | null>;
  /** Séances du programme, par rang. */
  programSessions(programId: string): Promise<SessionRecord[]>;
  walletOperations(sessionId: string): Promise<WalletOperationRecord[]>;
  directPayments(sessionId: string): Promise<DirectPaymentRecord[]>;
  settings(): Promise<ExecutionSettings>;
  /** Jours fériés (AAAA-MM-JJ, Porto-Novo) de la période. */
  holidays(from: Date, to: Date): Promise<string[]>;
}

export interface ExecutionTx extends ExecutionReader {
  /** Verrou du programme (SELECT … FOR UPDATE), avant toute lecture de ses séances. */
  lockProgram(programId: string): Promise<void>;
  /**
   * Verrou de l'organisation (RV-85), à prendre avant celui du programme ; rend la situation de
   * l'organisation dans cette transaction (réévaluation à la reprise d'un programme, R-SU-01).
   */
  organization(organizationId: string): Promise<OrganizationTransaction>;
  /** Refuse (ConcurrentUpdateError) si la version a changé ; null : sans contrôle de version. */
  updateSession(id: string, expectedVersion: number | null, patch: SessionPatch): Promise<void>;
  updateProgram(id: string, patch: ProgramPatch): Promise<void>;
  /**
   * Cause ajoutée ou levée ; `status` change le statut du programme dans la même écriture que le
   * cache des causes (contrainte programs_suspension_check : suspendu ⇔ au moins une cause).
   */
  addCause(
    programId: string,
    cause: ActiveCause,
    status?: { status: ProgramStatus; suspendedAt: Date | null },
  ): Promise<void>;
  liftCause(
    programId: string,
    cause: SuspensionCauseCode,
    at: Date,
    by: string | null,
    status?: { status: ProgramStatus; suspendedAt: Date | null },
  ): Promise<void>;
  /** R-RC-05 : la note d'une séance alimente la fiche de chacun de ses agents. */
  rateAgents(agentIds: readonly string[], stars: number): Promise<void>;
  insertIncident(sessionId: string, incident: Incident): Promise<void>;
  decideIncidents(sessionId: string, incidents: readonly Incident[]): Promise<void>;
  insertReschedule(sessionId: string, reschedule: Reschedule): Promise<void>;
  /** Affectations en vigueur des séances retirées (statut removed) ; rend les agents libérés. */
  releaseAssignments(
    sessionIds: readonly string[],
    removal: { by: string | null; reason: string; at: Date },
    agentIds?: readonly string[],
  ): Promise<string[]>;
  /**
   * R-RP-01 : agents de la séance qui ne passent plus au nouveau créneau sur les contrôles non
   * contournables (agent inactif, autre affectation en vigueur qui chevauche, trajet compris,
   * indisponibilité déclarée). Lu sous le verrou de l'agenda des agents.
   */
  blockedAgents(sessionId: string, agentIds: readonly string[], start: Date, end: Date): Promise<string[]>;
  /** Période occupée des affectations en vigueur d'une séance reportée. */
  moveAssignments(sessionId: string, start: Date, end: Date): Promise<void>;
  insertWalletOperation(operation: NewWalletOperation): Promise<void>;
  completeWalletOperation(
    id: string,
    result: {
      status: 'succeeded' | 'failed';
      walletTransactionId: string | null;
      failureCode: string | null;
      at: Date;
    },
  ): Promise<void>;
  /** Nouvelle tentative avec la même clé après un solde insuffisant : l'opération repasse en cours. */
  reopenWalletOperation(id: string, amount: number, at: Date): Promise<void>;
  insertDirectPayment(payment: NewDirectPayment): Promise<void>;
  updateDirectPayment(
    id: string,
    patch: {
      paymentRequestId?: string;
      checkoutUrl?: string | null;
      expiresAt?: Date | null;
      status?: DirectPaymentRecord['status'];
      completedAt?: Date | null;
    },
  ): Promise<void>;
  write(changes: Changes): Promise<void>;
}

export interface NewWalletOperation {
  id: string;
  idempotencyKey: string;
  attempt: number;
  walletOwnerKind: OwnerKind;
  walletOwnerId: string;
  amount: number;
  label: string;
  requestId: string;
  sessionId: string;
  createdAt: Date;
}

export interface NewDirectPayment {
  id: string;
  idempotencyKey: string;
  payerKind: OwnerKind;
  payerId: string;
  amount: number;
  requestId: string;
  sessionId: string;
  expiresAt: Date | null;
  createdAt: Date;
}

/** Séance d'une liste (client, back-office, tâches). */
export interface SessionListFilter {
  programId: string;
}

/** Séance qu'une tâche planifiée doit traiter. */
export interface DueSessionRef {
  sessionId: string;
  programId: string;
}

export interface ExecutionRepository extends ExecutionReader {
  transaction<T>(work: (tx: ExecutionTx) => Promise<T>): Promise<T>;
  listPrograms(
    filter: ProgramFilter,
    page: { limit: number; cursor: string | null },
  ): Promise<Page<ProgramRecord>>;
  /** Séances « à payer » dont le délai est échu (tâche du retard). */
  sessionsPastDue(now: Date, limit: number): Promise<DueSessionRef[]>;
  /**
   * Couverture (SES-01, R-PL-06, R-PL-10) : séances « à affecter » qui commencent dans 48 h ou
   * moins (ou déjà commencées), séances planifiées pas démarrées 1 h après leur début.
   */
  sessionsToWatch(now: Date, limit: number): Promise<DueSessionRef[]>;
  /** Séances prévues d'ici `until`, sans rappel envoyé. */
  sessionsToRemind(until: Date, limit: number): Promise<DueSessionRef[]>;
  /** Séances payées dont la facture n'est pas encore confirmée par billing. */
  sessionsAwaitingInvoice(limit: number): Promise<DueSessionRef[]>;
  /** Opérations de wallet en cours depuis avant `before` (reprise 15.4). */
  pendingWalletOperations(
    before: Date,
    limit: number,
  ): Promise<(WalletOperationRecord & { programId: string })[]>;
  /** Séances d'un titulaire en attente de débit (« à payer » ou « en retard »). */
  sessionsAwaitingDebit(holder: { kind: OwnerKind; id: string }): Promise<DueSessionRef[]>;
  /** Paiement direct par sa demande de paiement ou par son identifiant. */
  directPayment(ref: { paymentRequestId?: string; id?: string }): Promise<DirectPaymentRecord | null>;
  /** Opération de wallet par transaction wallet (rapprochement, RV-80). */
  walletOperationByTransaction(
    transactionId: string,
  ): Promise<(WalletOperationRecord & { purpose: string }) | null>;
  /**
   * Piste P — R-PG-07 : programmes récurrents, ni suspendus ni annulés, sans proposition ni
   * renouvellement, dont la dernière séance non annulée commence entre `from` et `until`.
   */
  programsToRenew(from: Date, until: Date, limit: number): Promise<string[]>;
  /** Séances d'un agent sur une période (mon activité). */
  agentSessions(agentId: string, from: Date, to: Date): Promise<SessionRecord[]>;
  /** Opérations de wallet d'un objet débité (rapprochement, RV-80). */
  walletOperationsFor(object: {
    type: 'cleaning_session' | 'cleaning_visit_fee';
    id: string;
  }): Promise<WalletOperationRecord[]>;
}

/** Réglages lus par le lot E (partie 16.1). */
export interface ExecutionSettings {
  freeCancellationHours: number;
  maxReschedulesPerMonth: number;
  lateCancellationFeePct: number;
  sessionPaymentGraceHours: number;
  overdueSessionsBeforeSuspension: number;
  balanceGuarantee: boolean;
  firstSessionLeadHours: number;
  maxPhotosPerType: number;
  claimWindowHours: number;
  arrivalAlertMeters: number;
  arrivalMaxAdvanceMinutes: number;
  customerWaitMinutes: number;
  commonChecklist: { code: string; label: string }[];
  deductVisitFee: boolean;
}

// --- Services appelés --------------------------------------------------------------------------

/** Solde prépayé d'un titulaire (wallet.GetPrepaidBalance). */
export interface WalletBalances {
  balance(holder: { type: 'user' | 'organization'; id: string }): Promise<number>;
}

/** Facture de séance émise par billing (InvoiceIssuanceService.IssueInvoice, R-PP-06). */
export interface SessionInvoiceRequest {
  idempotencyKey: string;
  customerId: string;
  sessionId: string;
  requestNumber: string;
  programNumber: string;
  sessionRank: string;
  placeLabel: string;
  serviceDate: string;
  lines: {
    label: string;
    amount: number;
    kind: 'session' | 'missed_session' | 'late_cancellation' | 'visit_fee_deduction';
  }[];
  payment: { reference: string | null; amount: number; paidAt: Date };
}

export interface InvoiceIssuer {
  issueSessionInvoice(request: SessionInvoiceRequest): Promise<{ invoiceId: string }>;
}

/** Paiement direct par Mobile Money (payment.CreatePaymentRequest, R-WL-05). */
export interface DirectPaymentGateway {
  create(input: {
    idempotencyKey: string;
    customerId: string;
    organizationId: string | null;
    amount: number;
    target: { objectType: 'cleaning_session'; objectId: string; reference: string };
    description: string;
    expiresAt: Date | null;
  }): Promise<{ paymentId: string; checkoutUrl: string; expiresAt: Date | null }>;
}
