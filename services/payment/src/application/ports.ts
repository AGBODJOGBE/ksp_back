import { type PaymentEventPayloads, type PaymentEventType } from '@ksp/contracts';
import { type InvoiceDue, type MissionDue, type SucceededPayment } from '../domain/amount-due';
import { type PaymentLink } from '../domain/payment-link';
import {
  type PaymentIntent,
  type PaymentStatus,
  type ProviderName,
  type ProviderStatus,
  type SubjectType,
} from '../domain/payment-intent';
import {
  type Payout,
  type PayoutBeneficiary,
  type PayoutProviderName,
  type PayoutStatus,
  type ProviderPayoutStatus,
} from '../domain/payout';

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
  subjectType?: string;
  subjectId?: string;
  customerId?: string;
  /** null : paiements sans organisation (contexte personnel). */
  organizationId?: string | null;
  /** true : écarts de montant pas encore traités par la finance ; false : tous les autres. */
  underReview?: boolean;
}

/** Issue de l'enregistrement d'un nouveau paiement. */
export type CreatedIntent =
  | { created: true; intent: PaymentIntent }
  | { created: false; intent: PaymentIntent; conflict: 'idempotency_key' | 'open_checkout' };

export interface PaymentRepository {
  /**
   * Enregistre un nouveau paiement. Idempotent par (payeur, clé) : si la clé existe déjà (envoi
   * concurrent), renvoie le paiement enregistré avec `created: false` et `conflict:
   * 'idempotency_key'`. Une seule page en attente par objet à montant dû (mission, facture) et par
   * lien (index uniques, ADR-048) : sinon renvoie celle qui existe, avec `conflict: 'open_checkout'`.
   */
  create(intent: PaymentIntent): Promise<CreatedIntent>;
  /**
   * Paiement en attente d'un objet, quel que soit le payeur ou la part (au plus un pour une mission
   * ou une facture, ADR-048) ; le plus récent, null s'il n'y en a pas.
   */
  findPendingForSubject(input: { subjectType: string; subjectId: string }): Promise<PaymentIntent | null>;
  findById(id: string): Promise<PaymentIntent | null>;
  findByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<PaymentIntent | null>;
  findByTransaction(provider: ProviderName, transactionId: string): Promise<PaymentIntent | null>;
  /** Essai de paiement d'un lien enregistré avec cette clé (rejeu), null sinon. */
  findByLinkKey(paymentLinkId: string, idempotencyKey: string): Promise<PaymentIntent | null>;
  /** Essais de paiement d'un lien, les plus anciens d'abord (peu nombreux : limités par heure). */
  listForLink(paymentLinkId: string): Promise<PaymentIntent[]>;
  /** Paiement en attente, non expiré, du même payeur pour le même objet (réutilisable). */
  findOpen(input: {
    customerId: string;
    subjectType: SubjectType;
    subjectId: string;
    part: string | null;
    now: Date;
  }): Promise<PaymentIntent | null>;
  /**
   * Paiements réussis (`succeeded`) d'un objet, quel que soit le payeur ou la part, avec l'instant de
   * leur réussite.
   */
  listSucceeded(input: { subjectType: string; subjectId: string }): Promise<SucceededPayment[]>;
  /**
   * Identifiants des paiements `amount_mismatch` d'un objet que la finance n'a pas encore traités,
   * quel que soit le payeur ou la part (ADR-032).
   */
  listUnresolvedMismatches(input: { subjectType: string; subjectId: string }): Promise<string[]>;
  /**
   * Paiements du payeur pas encore réglés : en attente, ou écart de montant pas encore traité par
   * la finance (« en vérification »), les plus anciens d'abord. Ils bloquent la suppression de son
   * compte (UC-ID-11, ADR-036).
   */
  listOpenForCustomer(customerId: string): Promise<PaymentIntent[]>;
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

/** Liens de paiement (ADR-040). */
export interface PaymentLinkRepository {
  /**
   * Enregistre un nouveau lien. Idempotent par (émetteur, clé) : si la clé existe déjà (envoi
   * concurrent), renvoie le lien enregistré avec `created: false`.
   */
  create(link: PaymentLink, tokenHash: string): Promise<{ created: boolean; link: PaymentLink }>;
  findById(id: string): Promise<PaymentLink | null>;
  findByTokenHash(tokenHash: string): Promise<PaymentLink | null>;
  findByIssuerKey(issuer: string, idempotencyKey: string): Promise<PaymentLink | null>;
  /** Liens d'un même objet, les plus récents d'abord. */
  listForSubject(subjectType: string, subjectId: string): Promise<PaymentLink[]>;
  /** Enregistre le lien si sa version n'a pas changé depuis la lecture ; sinon false. */
  save(link: PaymentLink): Promise<boolean>;
}

/**
 * Jetons des liens : longs et imprévisibles, dérivés d'un secret du service et de l'identifiant du
 * lien (l'émetteur peut le relire, par exemple pour renvoyer le message) ; seule l'empreinte est
 * enregistrée, et c'est elle qui sert à retrouver le lien.
 */
export interface LinkTokens {
  issue(linkId: string): string;
  /** Empreinte d'un jeton reçu (format déjà vérifié). */
  hash(token: string): string;
}

export interface PayoutFilter {
  status?: PayoutStatus;
  issuer?: string;
}

/** Reversements (ADR-041). */
export interface PayoutRepository {
  /** Idempotent par (émetteur, clé) : un envoi concurrent renvoie le reversement enregistré. */
  create(payout: Payout): Promise<{ created: boolean; payout: Payout }>;
  findById(id: string): Promise<Payout | null>;
  findByIssuerKey(issuer: string, idempotencyKey: string): Promise<Payout | null>;
  findByProviderPayoutId(provider: PayoutProviderName, providerPayoutId: string): Promise<Payout | null>;
  /** Enregistre le reversement et ses événements (outbox) si sa version n'a pas changé ; sinon false. */
  save(payout: Payout, events: OutboxMessage[]): Promise<boolean>;
  list(filter: PayoutFilter, page: PageRequest): Promise<PageResult<Payout>>;
  /**
   * Reversements à faire avancer chez le prestataire : `requested` (à créer ou à lancer), ou
   * `processing` pas relus depuis `checkedBefore` ; jamais relus d'abord.
   */
  listToReconcile(input: {
    provider: PayoutProviderName;
    checkedBefore: Date;
    limit: number;
  }): Promise<Payout[]>;
}

export interface ProviderPayout {
  providerPayoutId: string;
  status: ProviderPayoutStatus;
  reference: string | null;
  amount: number;
  currency: string;
}

/**
 * Exécution des reversements : prestataire (créer sans envoyer, puis lancer, relire), ou mode manuel
 * (aucun appel : la finance fait le virement et le confirme au back-office).
 */
export type PayoutProvider =
  | { readonly name: 'manual'; readonly automatic: false }
  | {
      readonly name: 'fedapay';
      readonly automatic: true;
      /** Crée le reversement chez le prestataire, sans l'envoyer. Panne : AppError UNAVAILABLE. */
      createPayout(request: {
        payoutId: string;
        amount: number;
        currency: 'XOF';
        beneficiary: PayoutBeneficiary;
      }): Promise<{ providerPayoutId: string; reference: string | null }>;
      /** Lance l'envoi d'un reversement créé. */
      startPayout(providerPayoutId: string): Promise<void>;
      getPayout(providerPayoutId: string): Promise<ProviderPayout>;
    };

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
  /** Objet de la notification : transaction (paiement) ou reversement (ADR-041). */
  entity: 'transaction' | 'payout';
  /** Identifiant chez le prestataire de la transaction ou du reversement. */
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
  /**
   * Délai après lequel un paiement encore en attente expire, quand le prestataire sait annuler sa
   * page (sinon : `checkoutValidityMinutes`).
   */
  intentTtlMinutes: number;
  /**
   * Durée pendant laquelle une page du prestataire peut encore être payée s'il ne sait pas l'annuler
   * (FedaPay : non documentée, 24 h par défaut, à valider ; ADR-048). Le paiement reste en attente
   * (page réutilisée, aucune autre ouverte pour l'objet) jusque-là. En minutes.
   */
  checkoutValidityMinutes: number;
  /** Adresse du portail où le client revient : <returnUrl>/<id du paiement>. */
  returnUrl: string;
  /** Intervalle minimal entre deux relectures d'un même paiement chez le prestataire. */
  recheckAfterSeconds: number;
  /** Simulation autorisée : prestataire simulé, hors production. */
  simulationEnabled: boolean;
  /**
   * Durée, depuis sa réussite, pendant laquelle un paiement pas encore enregistré par cleaning ou
   * billing fait refuser un nouveau paiement avec PAYMENT_ALREADY_RECEIVED (« réessayez ») ; au-delà,
   * PAYMENT_RECONCILIATION_PENDING (contacter le support) et alerte (ADR-032). En minutes.
   */
  unrecordedGraceMinutes: number;
  /** Durée pendant laquelle un paiement non abouti est encore relu (réussite tardive), en heures. */
  lateSuccessWindowHours: number;
  /** Intervalle entre deux relectures d'un paiement non abouti (réussite tardive), en minutes. */
  lateSuccessRecheckMinutes: number;
  /** Adresse publique des liens : <linkBaseUrl>/<jeton> (page du portail, ADR-040). */
  linkBaseUrl: string;
  /** Services autorisés à créer des liens (jeton de service). */
  linkIssuers: readonly string[];
  /** Essais de paiement acceptés par lien et par heure (au-delà : 429). */
  linkAttemptsPerHour: number;
  /** Services autorisés à demander des reversements (jeton de service). */
  payoutIssuers: readonly string[];
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
  /**
   * Paiement réussi toujours pas enregistré par cleaning ou billing au-delà du délai normal : un
   * nouveau paiement de l'objet est refusé jusqu'au rapprochement (ADR-032).
   */
  unrecordedPayment(input: {
    subjectType: string;
    subjectId: string;
    paymentIds: string[];
    since: Date;
  }): void;
  /**
   * Nouveau paiement refusé parce qu'un paiement de l'objet est en écart de montant, pas encore
   * traité par la finance (ADR-032) : à chaque refus.
   */
  paymentUnderReview(input: { subjectType: string; subjectId: string; paymentIds: string[] }): void;
  /**
   * Reversement relu chez le prestataire pour un autre montant ou une autre devise (ADR-041) : son
   * statut n'est pas appliqué, la finance vérifie.
   */
  payoutMismatch(input: {
    payoutId: string;
    providerPayoutId: string;
    expectedAmount: number;
    reportedAmount: number;
    currency: string;
  }): void;
  /**
   * Reversement refusé définitivement par le prestataire (HTTP 4xx) à sa création ou à son
   * lancement (ADR-048) : il passe en échec `provider_rejected`, la finance vérifie la cause.
   */
  payoutRejected(input: {
    payoutId: string;
    providerPayoutId: string | null;
    stage: 'create' | 'start';
    httpStatus: number;
  }): void;
  /**
   * Lancement d'un reversement sans réponse (panne, délai) : il est peut-être parti. Il reste
   * `processing` et n'est jamais relancé ; la relecture chez le prestataire tranche (ADR-048).
   */
  payoutStartUncertain(input: { payoutId: string; providerPayoutId: string }): void;
  /**
   * Paiement clos (expiré ou remplacé) alors que sa page n'a pas pu être annulée chez le prestataire
   * (ADR-048) : une réussite tardive reste possible ; elle est encore relue pendant la fenêtre de
   * réussite tardive, puis enregistrée comme trop-perçu si l'objet est déjà réglé.
   */
  checkoutClosedUnconfirmed(input: {
    paymentId: string;
    transactionId: string;
    reason: 'expired' | 'superseded';
  }): void;
}

/**
 * Noms affichés au back-office (identity, ADR-029), lus à l'affichage et jamais enregistrés. Lecture
 * au mieux : un compte sans nom est absent du résultat, et une panne d'identity rend des noms
 * absents au lieu d'une erreur (la liste reste utilisable).
 */
export interface PeopleDirectory {
  userNames(userIds: readonly string[]): Promise<Map<string, string>>;
  organizationNames(organizationIds: readonly string[]): Promise<Map<string, string>>;
}

/** Noms affichés d'une réponse du back-office, par identifiant de compte et d'organisation. */
export interface NameBook {
  users: ReadonlyMap<string, string>;
  organizations: ReadonlyMap<string, string>;
}

export interface PaymentDeps {
  payments: PaymentRepository;
  links: PaymentLinkRepository;
  linkTokens: LinkTokens;
  payouts: PayoutRepository;
  payoutProvider: PayoutProvider;
  people: PeopleDirectory;
  notifications: ProviderNotificationLog;
  dues: AmountDueDirectory;
  provider: PaymentProvider;
  alerts: PaymentAlerts;
  settings: PaymentSettings;
  clock: Clock;
  ids: IdGenerator;
}
