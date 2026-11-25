import {
  type CommissionCollection,
  type CommissionInvoice,
  type CommissionInvoiceStatus,
  type CreditorRef,
} from '../../domain/commission-invoice';
import { type FeeReceipt } from '../../domain/fee-receipt';
import { type BillingMonth } from '../../domain/monthly-invoice';
import {
  type Clock,
  type IdGenerator,
  type OrganizationDirectory,
  type OutboxMessage,
  type PageRequest,
  type PageResult,
  type WalletLedger,
} from '../ports';

/**
 * Ports de la facturation du recouvrement (ADR-064) : encaissements appris par événement, facture
 * mensuelle de commission, débit automatique, reçus des frais de dossier. Chaque écriture et ses
 * événements partent dans la même transaction (outbox) ; les numéros sont tirés du compteur de leur
 * série dans cette transaction (aucun trou).
 */
export interface CommissionInvoiceFilter {
  /** Périmètre du client : son compte, ou son organisation active. */
  creditor?: CreditorRef;
  /** Back-office : un créancier, compte ou organisation. */
  creditorId?: string;
  status?: CommissionInvoiceStatus;
  /** Mois facturé : son premier instant. */
  periodStart?: Date;
}

export interface FeeReceiptFilter {
  payer: CreditorRef;
  caseId?: string;
}

export interface RecoveryBillingRepository {
  /**
   * Encaissement reçu par événement : inbox (événement, consommateur) et encaissement dans la même
   * transaction. Événement déjà traité, ou encaissement déjà connu : `duplicate`, rien n'est écrit.
   */
  recordCollection(
    collection: CommissionCollection,
    inbox: { eventId: string; consumer: string },
  ): Promise<'recorded' | 'duplicate'>;
  /**
   * Créanciers sans facture pour `month` qui ont des encaissements non facturés reçus avant la fin du
   * mois, `limit` au plus (les suivants au passage suivant).
   */
  listCreditorsToInvoice(month: BillingMonth, limit: number): Promise<CreditorRef[]>;
  /**
   * Émet la facture de commission d'un créancier pour un mois, si elle n'existe pas encore : sous un
   * verrou du créancier, encaissements non facturés relus (reçus avant la fin du mois), `draft`
   * construit la facture (null : rien à facturer), numéro tiré du compteur FCR de l'année du mois,
   * lignes figées, encaissements rattachés, outbox. null si la facture du mois existe déjà (une seule
   * par créancier et par mois) ou si `draft` ne facture rien.
   */
  issueCommissionInvoice(
    creditor: CreditorRef,
    month: BillingMonth,
    draft: (collections: CommissionCollection[]) => Omit<CommissionInvoice, 'number'> | null,
    events: (invoice: CommissionInvoice) => OutboxMessage[],
  ): Promise<CommissionInvoice | null>;
  /** Factures dues dont le prochain débit est échu, les plus anciennes d'abord. */
  listDueDebits(now: Date, limit: number): Promise<CommissionInvoice[]>;
  /**
   * Enregistre le règlement ou l'état du débit (contrôle de version, facture encore due). Facture
   * modifiée entre-temps : false, rien n'est écrit.
   */
  saveDebit(invoice: CommissionInvoice): Promise<boolean>;
  findCommissionInvoice(id: string): Promise<CommissionInvoice | null>;
  listCommissionInvoices(
    filter: CommissionInvoiceFilter,
    page: PageRequest,
  ): Promise<PageResult<CommissionInvoice>>;
  /** Factures encore dues des créanciers donnés, les plus anciennes d'abord. */
  listUnpaidForCreditors(creditors: readonly CreditorRef[]): Promise<CommissionInvoice[]>;
  /**
   * Reçu d'un débit reçu par événement : inbox, numéro tiré du compteur RFD de l'année `year`, reçu,
   * dans la même transaction. Événement déjà traité, ou reçu déjà émis pour cette transaction du
   * portefeuille : `duplicate`, rien n'est écrit.
   */
  recordFeeReceipt(
    receipt: Omit<FeeReceipt, 'number'>,
    year: number,
    inbox: { eventId: string; consumer: string },
  ): Promise<'recorded' | 'duplicate'>;
  listFeeReceipts(filter: FeeReceiptFilter, page: PageRequest): Promise<PageResult<FeeReceipt>>;
}

export interface RecoveryBillingDeps {
  recovery: RecoveryBillingRepository;
  /** En-tête des factures d'une organisation créancière (identity, GetOrganizationsByIds). */
  organizations: OrganizationDirectory;
  /** Débit de la commission `invoiced` du portefeuille prépayé du créancier (wallet.Debit). */
  wallet: WalletLedger;
  clock: Clock;
  ids: IdGenerator;
}

export interface RecoveryBillingOptions {
  /** Délai avant un nouveau débit après un solde insuffisant (un jour par défaut). */
  debitRetryDelayMs: number;
}
