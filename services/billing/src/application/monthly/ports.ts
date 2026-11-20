import { type CreditNote } from '../../domain/credit-note';
import { type Invoice } from '../../domain/invoice';
import { type BillableSession, type BillingMonth } from '../../domain/monthly-invoice';
import { type BillingDeps, type OutboxMessage } from '../ports';

/**
 * Ports du lot F : facture mensuelle des organisations, relances, avoirs, annulation, règlement
 * par le portefeuille après un crédit (CDC Nettoyage v2, partie 11.2). Les écritures et leurs
 * événements partent dans la même transaction (outbox) ; les compteurs publiés (impayées du
 * titulaire) sont lus dans cette transaction, d'où les fabriques d'événements.
 */
export interface MonthlyInvoiceRepository {
  /**
   * Séance facturable reçue par événement : inbox (événement, consommateur) et séance dans la même
   * transaction. Événement déjà traité, ou séance déjà connue : `duplicate`, rien n'est écrit.
   */
  recordBillableSession(
    session: BillableSession,
    inbox: { eventId: string; consumer: string },
  ): Promise<'recorded' | 'duplicate'>;
  /**
   * Organisations sans facture pour `month` qui ont des séances non facturées réalisées avant la
   * fin du mois, `limit` au plus (les suivantes au passage suivant).
   */
  listOrganizationsToInvoice(month: BillingMonth, limit: number): Promise<string[]>;
  /**
   * Émet la facture mensuelle d'une organisation pour un mois, si elle n'existe pas encore : sous
   * un verrou de l'organisation, séances non facturées relues (réalisées avant la fin du mois),
   * `draft` construit la facture (null : rien à facturer), numéro tiré du compteur de l'année de la
   * période, séances rattachées à la facture, outbox. null si la facture du mois existe déjà
   * (idempotent, une seule par organisation et par mois) ou si `draft` ne facture rien.
   */
  issueMonthly(
    organizationId: string,
    month: BillingMonth,
    draft: (sessions: BillableSession[]) => Omit<Invoice, 'number'> | null,
    events: (invoice: Invoice) => OutboxMessage[],
  ): Promise<Invoice | null>;
  /** Factures v2 encore « en attente » dont l'échéance est passée, les plus anciennes d'abord. */
  listPendingPastDue(now: Date, limit: number): Promise<Invoice[]>;
  /**
   * Factures mensuelles ouvertes (en attente ou impayées) qui peuvent avoir une relance échue
   * (première relance passée, toutes les relances pas encore traitées), avec les décalages déjà
   * traités ; les échéances les plus anciennes d'abord.
   */
  listOpenForReminders(
    now: Date,
    offsets: readonly number[],
    limit: number,
  ): Promise<{ invoice: Invoice; handled: number[] }[]>;
  /**
   * Relance traitée : `offset` envoyée (avec `events`), `skipped` sautées. Une relance déjà traitée
   * (deux passages simultanés) : false, rien n'est écrit.
   */
  recordReminder(
    invoiceId: string,
    offset: number,
    skipped: readonly number[],
    at: Date,
    events: OutboxMessage[],
  ): Promise<boolean>;
  /** Factures v2 impayées (« overdue ») d'une organisation (RV-87 : information pour billing). */
  countOverdueForOrganization(organizationId: string): Promise<number>;
  /** Avoir déjà émis par cet émetteur avec cette clé, ou null. */
  findCreditNoteByKey(issuedBy: string, idempotencyKey: string): Promise<CreditNote | null>;
  listCreditNotes(invoiceId: string): Promise<CreditNote[]>;
  /**
   * Enregistre l'avoir (numéro tiré du compteur de l'année d'émission) et l'état de la facture
   * (contrôle de version), puis les événements. Version changée : `conflict`, rien n'est écrit.
   */
  saveCreditNote(
    invoice: Invoice,
    note: Omit<CreditNote, 'number'>,
    events: (note: CreditNote, overdueCount: number) => OutboxMessage[],
  ): Promise<CreditNote | 'conflict'>;
  /**
   * Annule la facture (contrôle de version) ; `releaseSessions` : ses séances redeviennent à
   * facturer (facture suivante). `events` reçoit les impayées restantes du titulaire.
   */
  cancel(
    invoice: Invoice,
    releaseSessions: boolean,
    events: (overdueCount: number) => OutboxMessage[],
  ): Promise<boolean>;
}

/**
 * Crédit au portefeuille d'un titulaire (wallet.Credit, R-WL-04) : part d'un avoir au-delà du reste
 * dû. Idempotent par clé chez wallet.
 */
export interface WalletCredits {
  credit(input: {
    idempotencyKey: string;
    holder: { type: 'user' | 'organization'; id: string };
    amount: number;
    object: { objectType: string; objectId: string };
    description: string;
  }): Promise<{ transactionId: string }>;
}

export interface MonthlyBillingDeps extends BillingDeps {
  monthly: MonthlyInvoiceRepository;
  walletCredits: WalletCredits;
}
