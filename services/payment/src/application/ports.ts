import { type PaymentEventPayloads, type PaymentEventType } from '@ksp/contracts';
import { type InvoiceDue, type MissionDue } from '../domain/amount-due';
import {
  type PaymentIntent,
  type PaymentStatus,
  type ProviderName,
  type ProviderStatus,
  type SubjectType,
} from '../domain/payment-intent';

/**
 * Ports du service payment. Les événements sont écrits dans l'outbox, dans la transaction qui
 * enregistre le nouvel état du paiement (règle d'or n° 4).
 */
export type OutboxMessage = {
  [K in PaymentEventType]: { type: K; payload: PaymentEventPayloads[K] };
}[PaymentEventType];

export interface PageRequest {
  limit: number;
  cursor: string | null;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Clock {
  now(): Date;
}

/** Identifiants UUID v7 (triables par date de création). */
export interface IdGenerator {
  next(): string;
}

export interface PaymentFilter {
  status?: PaymentStatus;
  subjectType?: SubjectType;
  subjectId?: string;
  customerId?: string;
  /** null : paiements sans organisation (contexte personnel). */
  organizationId?: string | null;
}

export interface PaymentRepository {
  /**
   * Enregistre un nouveau paiement. Idempotent par (payeur, clé) : si la clé existe déjà (envoi
   * concurrent), renvoie le paiement enregistré avec `created: false`.
   */
  create(intent: PaymentIntent): Promise<{ created: boolean; intent: PaymentIntent }>;
  findById(id: string): Promise<PaymentIntent | null>;
  findByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<PaymentIntent | null>;
  findByTransaction(provider: ProviderName, transactionId: string): Promise<PaymentIntent | null>;
  /** Paiement en attente, non expiré, du même payeur pour le même objet (réutilisable). */
  findOpen(input: {
    customerId: string;
    subjectType: SubjectType;
    subjectId: string;
    part: string | null;
    now: Date;
  }): Promise<PaymentIntent | null>;
  /**
   * Enregistre le paiement si sa version n'a pas changé depuis la lecture, avec ses événements
   * (outbox) dans la même transaction ; sinon false.
   */
  save(intent: PaymentIntent, events: OutboxMessage[]): Promise<boolean>;
  list(filter: PaymentFilter, page: PageRequest): Promise<PageResult<PaymentIntent>>;
  /**
   * Paiements en attente à relire : créés avant `createdBefore`, jamais relus ou pas depuis
   * `checkedBefore` ; les jamais relus d'abord, puis les plus anciennement relus.
   */
  listPendingToReconcile(input: {
    checkedBefore: Date;
    createdBefore: Date;
    limit: number;
  }): Promise<PaymentIntent[]>;
  /**
   * Paiements non aboutis (échec, abandon, expiration) avec une transaction, terminés depuis
   * `lateSince` (réussite tardive), jamais relus ou pas depuis `checkedBefore` ; même ordre.
   * Quota distinct de celui des paiements en attente : ils ne les privent jamais de relecture.
   */
  listClosedToReconcile(input: {
    checkedBefore: Date;
    lateSince: Date;
    limit: number;
  }): Promise<PaymentIntent[]>;
}

/** Issue du traitement d'une notification du prestataire (journal, réponse au webhook). */
export type NotificationOutcome =
  'applied' | 'no_change' | 'unknown_transaction' | 'amount_mismatch' | 'transaction_mismatch' | 'ignored';

/**
 * Journal des notifications reçues du prestataire : nom de l'événement, transaction, paiement,
 * issue. Jamais le corps reçu (il contient le nom, le téléphone ou l'e-mail du payeur).
 */
export interface ProviderNotificationLog {
  record(entry: {
    id: string;
    provider: ProviderName;
    eventName: string;
    providerEventId: string | null;
    providerTransactionId: string | null;
    paymentId: string | null;
    outcome: NotificationOutcome;
    receivedAt: Date;
  }): Promise<void>;
}

/**
 * Montants dus, lus dans le service qui porte l'objet payé (RPC réservés à payment). Objet
 * inconnu : null. Une panne lève une erreur (le client réessaie avec la même clé).
 */
export interface AmountDueDirectory {
  missionDue(missionId: string): Promise<MissionDue | null>;
  invoiceDue(invoiceId: string): Promise<InvoiceDue | null>;
}

export interface CheckoutRequest {
  paymentId: string;
  amount: number;
  currency: 'XOF';
  /** Libellé visible sur la page de paiement : aucune donnée personnelle. */
  description: string;
  /** Page du portail où le client revient après le paiement. */
  returnUrl: string;
}

export interface Checkout {
  transactionId: string;
  reference: string | null;
  checkoutUrl: string;
}

export interface ProviderTransaction {
  transactionId: string;
  /** Paiement KSP inscrit à la création (métadonnée `payment_id`) ; null s'il est absent. */
  paymentId: string | null;
  reference: string | null;
  status: ProviderStatus;
  amount: number;
  currency: string;
}

/** Notification authentifiée (signature vérifiée par l'adaptateur), réduite à ce qui sert. */
export interface ProviderNotification {
  eventName: string;
  eventId: string | null;
  transactionId: string | null;
}

/**
 * Prestataire de paiement (ADR-031) : FedaPay en production, simulé en développement. Mêmes
 * opérations, même contrat ; le prestataire simulé seul sait régler une transaction lui-même.
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  /** Crée la transaction et sa page de paiement. Panne : AppError UNAVAILABLE. */
  createCheckout(request: CheckoutRequest): Promise<Checkout>;
  /** Relit la transaction chez le prestataire : seule source du statut. */
  getTransaction(transactionId: string): Promise<ProviderTransaction>;
  /**
   * Vérifie la signature de la notification (corps exact, en-tête, fraîcheur) et en extrait
   * l'événement ; signature absente, fausse ou trop ancienne : AppError INVALID_ARGUMENT.
   */
  verifyNotification(payload: Uint8Array, signature: string, now: Date): ProviderNotification;
  /**
   * Annule une transaction encore en attente chez le prestataire (page qui ne doit plus être payée).
   * Absente si son API ne le permet pas (FedaPay : non documenté, ADR-031). Renvoie false si la
   * transaction n'est plus annulable ; au mieux : une panne n'empêche pas l'expiration locale.
   */
  cancelTransaction?(transactionId: string): Promise<boolean>;
  /** Prestataire simulé seulement : règle ou refuse la transaction (comme le ferait le client). */
  settle?(transactionId: string, outcome: 'succeeded' | 'failed'): Promise<void>;
}

/** Réglages des cas d'usage, lus dans la configuration du service. */
export interface PaymentSettings {
  /** Délai après lequel un paiement encore en attente expire. */
  intentTtlMinutes: number;
  /** Adresse du portail où le client revient : <returnUrl>/<id du paiement>. */
  returnUrl: string;
  /** Intervalle minimal entre deux relectures d'un même paiement chez le prestataire. */
  recheckAfterSeconds: number;
  /** Simulation autorisée : prestataire simulé, hors production. */
  simulationEnabled: boolean;
  /** Durée pendant laquelle un paiement non abouti est encore relu (réussite tardive), en heures. */
  lateSuccessWindowHours: number;
  /** Intervalle entre deux relectures d'un paiement non abouti (réussite tardive), en minutes. */
  lateSuccessRecheckMinutes: number;
}

/**
 * Alertes à traiter par la finance (journal d'erreurs, identifiants et montants seulement) : montant
 * ou devise approuvés différents, transaction relue qui ne correspond pas au paiement.
 */
export interface PaymentAlerts {
  amountMismatch(input: {
    paymentId: string;
    transactionId: string;
    expectedAmount: number;
    approvedAmount: number;
    currency: string;
  }): void;
  transactionMismatch(input: {
    paymentId: string;
    expectedTransactionId: string | null;
    receivedTransactionId: string;
    receivedPaymentId: string | null;
  }): void;
}

export interface PaymentDeps {
  payments: PaymentRepository;
  notifications: ProviderNotificationLog;
  dues: AmountDueDirectory;
  provider: PaymentProvider;
  alerts: PaymentAlerts;
  settings: PaymentSettings;
  clock: Clock;
  ids: IdGenerator;
}
