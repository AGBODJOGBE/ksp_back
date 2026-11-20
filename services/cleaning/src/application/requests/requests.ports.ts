import { type ParameterValue } from '../../domain/pricing/types';
import {
  type CaseProgramStatus,
  type Reactivation,
  type TimeSlot,
} from '../../domain/requests/request-lifecycle';
import { type RequestStatus } from '../../domain/requests/request-status';
import { type VisitFee } from '../../domain/requests/visit-fee';
import { type Quote } from '../../domain/quotes/quote';
import { type SchedulePlan } from '../../domain/schedule-plan/plan';
import { type RetainedRevision, type ValueReason } from '../../domain/visits/observation';
import { type Visit } from '../../domain/visits/visit';
import { type Page, type PageRequest } from '../shared/input';
import { type Changes, type OutboxMessage } from '../ports';

/**
 * Dépôts du dossier (lot C, parties 3 et 7) : lieux du client, demande et tout ce qui s'y rattache
 * (frais de visite, visites, version retenue, devis, réactivations), puis le programme créé à
 * l'acceptation. Les données personnelles (position, repère, adresses) arrivent déjà chiffrées par
 * l'application (FieldCipher) : le dépôt ne voit jamais de clair. Chaque écriture porte ses
 * événements et traces (`Changes`), écrits dans la même transaction que l'état.
 */

export type OwnerKind = 'user' | 'organization';

export interface Owner {
  kind: OwnerKind;
  id: string;
}

export type DeclaredValues = Record<string, ParameterValue>;

/** Champs chiffrés d'une position de lieu ou de dossier (R-DM-08). */
export interface EncryptedLocation {
  gpsEncrypted: string | null;
  landmarkEncrypted: string | null;
  addressEncrypted: string | null;
  readableAddressEncrypted: string | null;
  communeKey: string;
  communeBoundariesVersion: string | null;
  locationErasedAt: Date | null;
}

/** Lieu de « Mes lieux » (partie 3). */
export interface PlaceRecord extends EncryptedLocation {
  id: string;
  owner: Owner;
  placeTypeId: string;
  name: string;
  declaredValues: DeclaredValues;
  locationCorrectedAt: Date | null;
  locationCorrectedBy: string | null;
  archivedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface PlaceRepository {
  findPlace(id: string): Promise<PlaceRecord | null>;
  /** Lieux du titulaire, archivés compris si demandé ; tri `-createdAt` ou `name`. */
  listPlaces(
    owner: Owner,
    filter: { archived: boolean; sort: 'name' | '-createdAt' },
  ): Promise<PlaceRecord[]>;
  insertPlace(place: PlaceRecord, changes: Changes): Promise<void>;
  /** Refuse (ConcurrentUpdateError) si la version a changé. */
  updatePlace(place: PlaceRecord, expectedVersion: number, changes: Changes): Promise<void>;
}

/** Ligne déclarée figée à l'envoi (libellé, unité, valeur affichée), dans l'ordre du formulaire. */
export interface DeclaredRow {
  parameterCode: string;
  label: string;
  unit: string | null;
  value: ParameterValue;
}

/** Demande de devis (partie 7.1) et sa copie chiffrée de la position (R-DM-08). */
export interface RequestRecord extends EncryptedLocation {
  id: string;
  /** DN-000124, attribué par la base à la création. */
  number: string;
  owner: Owner;
  submittedBy: string;
  placeId: string;
  placeTypeId: string;
  status: RequestStatus;
  declaredValues: DeclaredValues;
  declaredRows: DeclaredRow[];
  cleaningTypeIds: string[];
  /** Offre et version de tarif de chaque type choisi (R-DM-03). */
  items: { offerId: string; cleaningTypeId: string; tariffVersionId: string | null }[];
  schedulePlan: SchedulePlan;
  visitSlots: TimeSlot[];
  pricingSnapshot: unknown;
  estimatedSessionPrice: number | null;
  description: string | null;
  comment: string | null;
  photoFileIds: string[];
  closingReason: string | null;
  closingReasonCode: string | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

/** Visite enregistrée, avec le constat de l'agent. */
export interface VisitRecord extends Visit {
  observedValues: DeclaredValues | null;
  observationNote: string | null;
  observedBy: string | null;
  observedAt: Date | null;
  photoFileIds: string[];
  arrivalGpsEncrypted: string | null;
  arrivalDistanceM: number | null;
  changeReason: string | null;
  createdBy: string;
  createdAt: Date;
}

/** Révision de la version retenue, avec son calcul et ses écarts. */
export interface RevisionRecord extends RetainedRevision {
  id: string;
  pricingSnapshot: unknown;
  diff: unknown[];
  reasons: ValueReason[];
}

export interface QuoteRecord extends Quote {
  schedulePlan: SchedulePlan;
  sentBy: string | null;
  /** Validité choisie à la composition ; null : réglage (15 jours) au moment de l'envoi. */
  validityDays: number | null;
}

export interface ReactivationRecord extends Reactivation {
  id: string;
  reason: string | null;
}

/** Dossier complet d'une demande : lu et réécrit d'un bloc, sous verrou optimiste (version). */
export interface CaseRecord {
  request: RequestRecord;
  fees: VisitFee[];
  visits: VisitRecord[];
  revisions: RevisionRecord[];
  quotes: QuoteRecord[];
  reactivations: ReactivationRecord[];
  /** Programme créé à l'acceptation ; null avant. */
  programId: string | null;
  /** Numéro PN-… du programme, attribué par la base. */
  programNumber: string | null;
  programStatus: CaseProgramStatus | null;
}

/** Programme créé à l'acceptation du devis (R-AC-01, R-PG-05), séances « à affecter ». */
export interface NewProgram {
  id: string;
  requestId: string;
  quoteId: string;
  owner: Owner;
  payerKind: 'individual' | 'organization';
  placeId: string;
  communeKey: string;
  sessionPrice: number;
  teamSize: number;
  durationMinutes: number;
  schedulePlan: SchedulePlan;
  visitFeeToDeduct: number;
  createdAt: Date;
  sessions: {
    id: string;
    rank: number;
    scheduledStart: Date;
    scheduledEnd: Date;
    price: number;
    visitFeeDeducted: number;
  }[];
}

export type WalletOperationPurpose = 'visit_fee' | 'visit_fee_refund';

/** Débit ou remboursement demandé au wallet, écrit « en cours » avant l'appel (15.4, RV-80). */
export interface WalletOperationRecord {
  id: string;
  kind: 'debit' | 'credit';
  purpose: WalletOperationPurpose;
  idempotencyKey: string;
  attempt: number;
  holder: Owner;
  amount: number;
  label: string;
  requestId: string;
  visitFeeId: string;
  status: 'pending' | 'succeeded' | 'failed';
  walletTransactionId: string | null;
  failureCode: string | null;
  createdBy: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** Paiement direct par Mobile Money de frais de visite (R-WL-05, RV-89, RV-90). */
export interface DirectPaymentRecord {
  id: string;
  paymentRequestId: string | null;
  idempotencyKey: string;
  payer: Owner;
  amount: number;
  requestId: string;
  visitFeeId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'expired' | 'left_in_wallet';
  /** Page encore ouverte : renvoyée par payment pour la même clé (même checkoutUrl, RV-90). */
  expiresAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** Écritures annexes d'un enregistrement du dossier, dans la même transaction. */
export interface CaseWrites {
  changes: Changes;
  program?: NewProgram;
  /** Événements qui citent le numéro du programme (PN-…), attribué par la base à son insertion. */
  programEvents?: (programNumber: string) => OutboxMessage[];
  /** Visites à supprimer : planification annulée faute d'affectation possible (ScheduleVisit). */
  removedVisitIds?: string[];
  /** Lieu de « Mes lieux » corrigé avec le dossier (R-DM-07), sous son propre verrou optimiste. */
  place?: { record: PlaceRecord; expectedVersion: number };
  walletOperations?: WalletOperationRecord[];
  directPayments?: DirectPaymentRecord[];
}

export interface CaseFilter {
  owner?: Owner;
  statuses?: RequestStatus[];
  /** Communes de l'appelant (portée par zone, R-RB-03) ; 'all' : partout. */
  zones?: 'all' | string[];
  communeKey?: string;
  placeId?: string;
  search?: string;
}

export interface VisitListFilter {
  from: Date;
  to: Date;
  statuses?: string[];
  zones: 'all' | string[];
}

/** Dossiers que la tâche des échéances doit examiner (R-FV-03, R-AC-04, R-DV-04, RV-51). */
export interface DeadlineCandidates {
  unpaidFeeRequestIds: string[];
  expiredQuoteRequestIds: string[];
  reminderQuoteRequestIds: string[];
  closedWithLiveVisitRequestIds: string[];
}

export interface CaseRepository {
  findCase(requestId: string): Promise<CaseRecord | null>;
  findCaseByQuote(quoteId: string): Promise<CaseRecord | null>;
  findCaseByVisit(visitId: string): Promise<CaseRecord | null>;
  listCases(filter: CaseFilter, page: PageRequest): Promise<Page<CaseRecord>>;
  /** Demandes du titulaire dont le statut enregistré peut être « ouvert » (plafond R-DM-04). */
  openCandidates(owner: Owner): Promise<CaseRecord[]>;
  listVisits(
    filter: VisitListFilter,
    page: PageRequest,
  ): Promise<Page<{ visit: VisitRecord; request: RequestRecord }>>;
  /** Crée la demande et ses frais de rang 1 ; rend le numéro attribué par la base. */
  insertCase(record: CaseRecord, writes: CaseWrites): Promise<string>;
  /**
   * Réécrit le dossier (demande, frais, visites, révisions, devis, réactivations) si sa version est
   * encore `expectedVersion` (sinon ConcurrentUpdateError) ; la version passe à `expectedVersion + 1`.
   */
  saveCase(record: CaseRecord, expectedVersion: number, writes: CaseWrites): Promise<void>;
  walletOperations(requestId: string): Promise<WalletOperationRecord[]>;
  /** Opérations des frais de visite encore « en cours » créées avant `before` (reprise RV-80). */
  stalePendingWalletOperations(before: Date, limit: number): Promise<WalletOperationRecord[]>;
  /** Issue d'une opération du wallet ; sans effet si elle n'est plus « en cours ». */
  completeWalletOperation(
    id: string,
    outcome: {
      status: 'succeeded' | 'failed';
      walletTransactionId: string | null;
      failureCode: string | null;
    },
    at: Date,
  ): Promise<boolean>;
  directPayments(requestId: string): Promise<DirectPaymentRecord[]>;
  findDirectPaymentByPaymentId(paymentRequestId: string): Promise<DirectPaymentRecord | null>;
  updateDirectPayment(
    id: string,
    patch: Partial<Pick<DirectPaymentRecord, 'status' | 'paymentRequestId' | 'expiresAt' | 'completedAt'>>,
  ): Promise<void>;
  /** Demandes « frais à payer » du titulaire, les plus anciennes d'abord (relance R-FV-02). */
  awaitingFeeRequestIds(owner: Owner): Promise<string[]>;
  /** Situation de l'organisation (R-AC-02, R-PE-06) : suspendue, factures impayées. */
  organizationStanding(organizationId: string): Promise<{ suspended: boolean; unpaidInvoices: number }>;
  deadlineCandidates(now: Date, reminderDays: number, limit: number): Promise<DeadlineCandidates>;
  /**
   * Verrou consultatif de la tâche des échéances (deux répliques) : `work` ne s'exécute que si le
   * verrou est pris ; rend false sinon.
   */
  withDeadlinesLock(work: () => Promise<void>): Promise<boolean>;
  /** Inbox des événements reçus : false si l'événement est déjà traité par ce consommateur. */
  markProcessed(eventId: string, consumer: string): Promise<boolean>;
}

/** Réglages du dossier (partie 16.1). */
export interface CaseSettings {
  maxOpenRequests: number;
  minVisitLeadHours: number;
  visitFeePaymentHours: number;
  visitDurationMinutes: number;
  defaultVisitFee: number;
  deductVisitFee: boolean;
  quoteValidityDays: number;
  quoteReminderDays: number;
  maxDiscountWithoutApprovalPct: number;
  firstSessionLeadHours: number;
  freeCancellationHours: number;
  maxPhotosPerType: number;
  arrivalAlertMeters: number;
  /** Factures impayées d'une organisation qui bloquent l'acceptation d'un devis (R-AC-02). */
  unpaidInvoicesSuspension: number;
}

export interface CaseSettingsReader {
  caseSettings(): Promise<CaseSettings>;
}

/** Commune dont le contour contient un point (geo.ResolveCommune, R-ZN-01, RV-47). */
export interface ResolvedCommune {
  commune: { key: string; name: string } | null;
  boundariesVersion: string | null;
}

/** geo indisponible : AppError CLEANING_GEO_UNAVAILABLE. */
export interface CommuneResolver {
  resolve(point: { latitude: number; longitude: number }): Promise<ResolvedCommune>;
}
