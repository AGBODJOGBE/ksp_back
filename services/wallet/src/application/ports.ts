import { type Holder, type InternalAccount, type LedgerTransaction } from '../domain/ledger';
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

/** Vue d'un titulaire : solde et cumuls, calculés depuis les écritures. */
export interface WalletSummary {
  holder: Holder;
  balance: number;
  payoutsInProgress: number;
  totalCollected: number;
  totalPaidOut: number;
  lastEntryAt: Date | null;
}

/** Une écriture sur le compte d'un titulaire, avec sa transaction (relevé). */
export interface StatementLine {
  /** Identifiant de l'écriture (curseur du relevé). */
  entryId: string;
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
}

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
  /** Solde du titulaire inférieur au minimum exigé (reversement). */
  | { kind: 'insufficient'; balance: number }
  /** Événement déjà traité (inbox). */
  | { kind: 'already_processed' }
  /** Reversement modifié en même temps (version) : rien n'est écrit, à réessayer. */
  | { kind: 'conflict' };

/**
 * Grand livre (ADR-042). Chaque écriture est atomique : compte du titulaire créé au besoin et
 * verrouillé, solde minimal contrôlé sous ce verrou, transaction et lignes insérées (les soldes et
 * `balance_after` sont tenus par la base), reversement créé ou mis à jour, marque d'inbox ; tout ou
 * rien. Les écritures ne se modifient ni ne se suppriment jamais.
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
  }): Promise<RecordOutcome>;
  findTransaction(id: string): Promise<LedgerTransaction | null>;
  findByReference(caller: string, reference: string): Promise<LedgerTransaction | null>;
  /** Écriture inverse d'une transaction, null si elle n'est pas annulée. */
  findReversalOf(transactionId: string): Promise<LedgerTransaction | null>;
  summary(holder: Holder): Promise<WalletSummary>;
  statement(holder: Holder, page: PageRequest): Promise<PageResult<StatementLine>>;
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

export interface WalletSettings {
  /** Services autorisés à écrire dans le grand livre et à lire les titulaires (recovery). */
  ledgerCallers: readonly string[];
}

export interface WalletDeps {
  ledger: LedgerStore;
  payouts: WalletPayoutRepository;
  executor: PayoutExecutor;
  settings: WalletSettings;
  clock: Clock;
  ids: IdGenerator;
}
