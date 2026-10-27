import { type BillingEventPayloads, type BillingEventType } from '@ksp/contracts';
import { type BillingContract } from '../domain/contract';
import {
  type Invoice,
  type InvoiceOrganization,
  type InvoicePayment,
  type InvoiceStatus,
} from '../domain/invoice';
import { type BillingSettings } from '../domain/settings';

/**
 * Ports du service billing. Les événements sont écrits dans l'outbox, dans la transaction de
 * l'état ; les compteurs qu'ils portent (factures impayées du contrat) sont lus dans cette
 * même transaction, d'où les fabriques d'événements passées aux adaptateurs.
 */
export type OutboxMessage = {
  [K in BillingEventType]: { type: K; payload: BillingEventPayloads[K] };
}[BillingEventType];

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

export interface ContractRepository {
  /**
   * Applique un événement de cleaning au contrat (verrouillé), avec l'inbox dans la même
   * transaction : un doublon n'a aucun effet. `change` reçoit le contrat actuel (ou null) et
   * renvoie le contrat à enregistrer, ou null pour ne rien changer.
   */
  apply(
    eventId: string,
    consumer: string,
    contractId: string,
    change: (current: BillingContract | null) => BillingContract | null,
  ): Promise<'processed' | 'duplicate'>;
  findById(id: string): Promise<BillingContract | null>;
  /** Contrats dont tous les mois civils ne sont pas encore facturés, avec les mois déjà facturés. */
  listOpen(): Promise<{ contract: BillingContract; invoicedIndexes: number[] }[]>;
}

export interface InvoiceFilter {
  customerId?: string;
  /** null : factures sans organisation (contexte personnel). */
  organizationId?: string | null;
  contractId?: string;
  status?: InvoiceStatus;
}

export interface InvoiceRepository {
  /**
   * Émet la facture d'un mois si elle n'existe pas encore : contrat verrouillé, numéro tiré du
   * compteur de l'année, outbox. Renvoie null si le mois est déjà facturé (idempotent).
   */
  issue(
    draft: Omit<Invoice, 'number'>,
    events: (invoice: Invoice) => OutboxMessage[],
  ): Promise<Invoice | null>;
  findById(id: string): Promise<Invoice | null>;
  list(filter: InvoiceFilter, page: PageRequest): Promise<PageResult<Invoice>>;
  /** Factures en attente de paiement dont l'échéance est passée. */
  listPastDue(now: Date): Promise<Invoice[]>;
  /**
   * Passe la facture en « impayée » si elle est encore en attente (contrôle de version).
   * `events` reçoit le nombre de factures impayées du contrat, celle-ci comprise.
   */
  markOverdue(invoice: Invoice, events: (overdueCount: number) => OutboxMessage[]): Promise<boolean>;
  /**
   * Enregistre le paiement et le nouvel état de la facture (contrôle de version). `events`
   * reçoit le nombre de factures du contrat encore impayées après ce paiement.
   */
  recordPayment(
    invoice: Invoice,
    payment: InvoicePayment,
    events: (overdueCount: number) => OutboxMessage[],
  ): Promise<boolean>;
}

/** Fiche d'une organisation lue dans identity, à copier dans l'en-tête de la facture. */
export interface OrganizationProfile extends InvoiceOrganization {
  id: string;
}

/**
 * Fiches des organisations facturées (identity, GetOrganizationsByIds). Une organisation inconnue
 * est simplement absente du résultat ; une panne lève une erreur (l'émission est reprise au
 * passage suivant de la tâche planifiée).
 */
export interface OrganizationDirectory {
  findByIds(organizationIds: readonly string[]): Promise<OrganizationProfile[]>;
}

export interface StoredBillingSettings extends BillingSettings {
  updatedBy: string | null;
  updatedAt: Date | null;
}

export interface SettingsRepository {
  get(): Promise<StoredBillingSettings>;
  save(settings: BillingSettings, updatedBy: string, at: Date): Promise<StoredBillingSettings>;
}

export interface BillingDeps {
  contracts: ContractRepository;
  invoices: InvoiceRepository;
  settings: SettingsRepository;
  organizations: OrganizationDirectory;
  clock: Clock;
  ids: IdGenerator;
}
