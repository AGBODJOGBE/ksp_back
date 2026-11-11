import { type WalletEventPayloads, type WalletEventType } from '@ksp/contracts';
import {
  type Holder,
  type InternalAccount,
  type LedgerTransaction,
  type StatementAccount,
} from '../domain/ledger';
import { type Operator, type WalletPayout, type WalletPayoutStatus } from '../domain/wallet-payout';

export interface Clock {
  now(): Date;
}

/** Identifiants UUID v7 (triables par date de création). */
export interface IdGenerator {
  next(): string;
}

export interface PageRequest {
  limit: number;
  cursor: string | null;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

/** Portefeuille prépayé d'un titulaire (ADR-046). */
export interface PrepaidSummary {
  holder: Holder;
  balance: number;
  lastEntryAt: Date | null;
}

/** Vue d'un titulaire : solde et cumuls, calculés depuis les écritures, et son portefeuille prépayé. */
export interface WalletSummary {
  holder: Holder;
  balance: number;
  payoutsInProgress: number;
  totalCollected: number;
  totalPaidOut: number;
  lastEntryAt: Date | null;
  prepaid: PrepaidSummary;
}

/** Une écriture sur le compte d'un titulaire, avec sa transaction (relevé). */
export interface StatementLine {
  /** Identifiant de l'écriture (curseur du relevé). */
  entryId: string;
  /** Compte de la ligne : fonds dus au titulaire, ou portefeuille prépayé. */
  account: StatementAccount;
  transaction: LedgerTransaction;
  direction: 'debit' | 'credit';
  amount: number;
  balanceAfter: number;
  payoutStatus: WalletPayoutStatus | null;
}

export interface LedgerOverview {
  internal: { account: InternalAccount; balance: number }[];
  owedToHolders: number;
  holdersCount: number;
  /** Somme des portefeuilles prépayés et leur nombre (ADR-046). */
  owedToCustomers: number;
  customersCount: number;
}

/** Événement écrit dans l'outbox avec l'écriture (ADR-046). */
export type WalletOutboxMessage = {
  [K in WalletEventType]: { type: K; payload: WalletEventPayloads[K] };
}[WalletEventType];

/** Marque de l'inbox, écrite dans la même transaction que l'écriture (événement reçu une fois). */
export interface InboxMark {
  eventId: string;
  consumer: string;
}

/** Issue d'une écriture. */
export type RecordOutcome =
  | { kind: 'recorded'; transaction: LedgerTransaction; holderBalance: number }
  /** Même (appelant, référence), ou même clé de reversement, déjà enregistrés : rien n'est écrit. */
  | { kind: 'duplicate' }
  /** Solde du titulaire inférieur au minimum exigé (reversement, débit du portefeuille). */
  | { kind: 'insufficient'; balance: number }
  /** Événement déjà traité (inbox). */
  | { kind: 'already_processed' }
  /** Reversement modifié en même temps (version) : rien n'est écrit, à réessayer. */
  | { kind: 'conflict' };

/**
 * Grand livre (ADR-042). Chaque écriture est atomique : compte du titulaire touché (fonds dus ou
 * portefeuille prépayé, selon la sorte d'écriture) créé au besoin et verrouillé, solde minimal
 * contrôlé sous ce verrou, transaction et lignes insérées (les soldes et `balance_after` sont tenus
 * par la base), reversement créé ou mis à jour, événements (outbox), marque d'inbox ; tout ou rien.
 * Les écritures ne se modifient ni ne se suppriment jamais.
 */
export interface LedgerStore {
  record(input: {
    transaction: LedgerTransaction;
    /** Solde du titulaire exigé avant l'écriture (reversement : son montant). */
    requireHolderBalance?: number;
    /** Reversement créé avec la retenue. */
    createPayout?: WalletPayout;
    /** Reversement mis à jour avec l'écriture qui le solde (contrôle de version). */
    updatePayout?: WalletPayout;
    inbox?: InboxMark;
    /** Événements de l'écriture, d'après le solde du compte touché après elle (outbox). */
    events?: (holderBalance: number) => WalletOutboxMessage[];
  }): Promise<RecordOutcome>;
  findTransaction(id: string): Promise<LedgerTransaction | null>;
  findByReference(caller: string, reference: string): Promise<LedgerTransaction | null>;
  /** Écriture inverse d'une transaction, null si elle n'est pas annulée. */
  findReversalOf(transactionId: string): Promise<LedgerTransaction | null>;
  summary(holder: Holder): Promise<WalletSummary>;
  prepaidSummary(holder: Holder): Promise<PrepaidSummary>;
  /** Écritures des comptes demandés du titulaire, les plus récentes d'abord. */
  statement(
    holder: Holder,
    accounts: readonly StatementAccount[],
    page: PageRequest,
  ): Promise<PageResult<StatementLine>>;
  overview(): Promise<LedgerOverview>;
}

export interface PayoutFilter {
  status?: WalletPayoutStatus;
  holder?: Holder;
}

export interface WalletPayoutRepository {
  findById(id: string): Promise<WalletPayout | null>;
  findByKey(caller: string, idempotencyKey: string): Promise<WalletPayout | null>;
  /** Enregistre si la version n'a pas changé ; sinon false. */
  save(payout: WalletPayout): Promise<boolean>;
  list(filter: PayoutFilter, page: PageRequest): Promise<PageResult<WalletPayout>>;
  /** Reversements pas encore transmis à payment, les plus anciens d'abord. */
  listPendingSubmission(limit: number): Promise<WalletPayout[]>;
}

/**
 * Reversements chez payment (PayoutService, jeton de service). Idempotent : la clé et la référence
 * sont l'identifiant du reversement wallet. Panne : AppError UNAVAILABLE ou DEADLINE_EXCEEDED.
 */
export interface PayoutExecutor {
  request(input: {
    idempotencyKey: string;
    reference: string;
    amount: number;
    beneficiary: { phone: string; operator: Operator; name: string };
  }): Promise<{ payoutId: string }>;
}

/** Recharge créée chez payment (objet wallet_top_up), telle que le portail la suit. */
export interface TopUpPayment {
  paymentId: string;
  amount: number;
  status: string;
  checkoutUrl: string | null;
  expiresAt: Date | null;
  created: boolean;
}

/**
 * Recharges chez payment (TopUpPaymentService, jeton de service) : le payeur est l'utilisateur de la
 * requête, transmis dans les métadonnées. Idempotent par (payeur, clé). Erreurs de payment
 * transmises telles quelles (prestataire injoignable : 503, même clé pour réessayer).
 */
export interface TopUpPayments {
  create(input: { idempotencyKey: string; amount: number }): Promise<TopUpPayment>;
}

/**
 * Empreinte d'un numéro de bénéficiaire (HMAC à clé secrète, ADR-048) : compare deux demandes sans
 * garder le numéro complet après la transmission à payment.
 */
export interface PhoneFingerprints {
  of(phone: string): string;
}

export interface WalletSettings {
  /** Services autorisés à écrire dans le grand livre et à lire les titulaires (recovery). */
  ledgerCallers: readonly string[];
  /** Services autorisés à débiter et rembourser les portefeuilles prépayés (ADR-046). */
  debitCallers: readonly string[];
  /** Montants de recharge acceptés, en XOF (ADR-046). */
  topUpMin: number;
  topUpMax: number;
}

export interface WalletDeps {
  ledger: LedgerStore;
  payouts: WalletPayoutRepository;
  executor: PayoutExecutor;
  topUps: TopUpPayments;
  fingerprints: PhoneFingerprints;
  settings: WalletSettings;
  clock: Clock;
  ids: IdGenerator;
}
