import { type OrganizationProgram, type ProgramChange } from './alignment';
import { type InvoiceStanding, type OrganizationBillingStanding, type UnpaidThresholds } from './standing';

/**
 * Ports du branchement à venir de la situation d'impayés des organisations (lot F). Interfaces
 * seules, sans implémentation : cleaning n'est pas branché dans ce lot (README du dossier). Au
 * branchement, ils rejoignent la couche application ; toutes les méthodes s'exécutent dans la
 * transaction ouverte par `OrganizationStandingUnitOfWork.run`.
 */

/** Transaction unique : verrou de l'organisation, inbox, état, programmes, outbox et audit. */
export interface OrganizationStandingUnitOfWork {
  /**
   * Exécute `work` dans une transaction, sous le verrou de l'organisation (RV-85 : `SELECT … FOR
   * UPDATE` sur organization_billing_standings, verrou consultatif si la ligne n'existe pas). Le
   * même verrou sert à SubmitRequest, PayVisitFee, AcceptQuote et aux écouteurs d'identity.
   */
  run<T>(organizationId: string, work: (tx: OrganizationStandingTransaction) => Promise<T>): Promise<T>;
}

export interface OrganizationStandingTransaction {
  /** Inbox : false si l'événement (identifiant, consommateur) est déjà traité. */
  markProcessed(eventId: string, consumer: string): Promise<boolean>;
  /** Situation de l'organisation ; absente : compte et niveau à 0, version 0. */
  standing(organizationId: string): Promise<OrganizationBillingStanding>;
  /** Enregistre la situation (contrôle de version). */
  saveStanding(standing: OrganizationBillingStanding): Promise<void>;
  /** État suivi d'une facture (organization_invoices), null si inconnue. */
  invoiceStanding(invoiceId: string): Promise<InvoiceStanding | null>;
  /** Enregistre l'état d'une facture suivie (RV-87). */
  saveInvoiceStanding(invoice: {
    invoiceId: string;
    organizationId: string;
    standing: InvoiceStanding;
    at: Date;
  }): Promise<void>;
  /** Factures impayées de l'organisation (identifiants), pour le compte et l'avertissement. */
  overdueInvoiceIds(organizationId: string): Promise<string[]>;
  /** Programmes Nettoyage non terminés de l'organisation, avec causes actives et séances. */
  openPrograms(organizationId: string): Promise<OrganizationProgram[]>;
  /**
   * Écrit les changements des programmes (statut, causes et leur historique RV-88, séances gelées
   * ou reprises, agents libérés, rattrapages proposés) avec l'acteur `system`, puis leurs
   * événements (`cleaning.program.suspended`, `.suspension_updated`, `.resumed`) et traces
   * (`program.suspended`, `program.cause_added`, `program.cause_lifted`, `program.resumed`).
   */
  applyProgramChanges(
    changes: readonly ProgramChange[],
    context: { unpaidCount: number; at: Date },
  ): Promise<void>;
  /** Publie `cleaning.organization.unpaid_warning` et la trace `organization.unpaid_warning`. */
  publishUnpaidWarning(payload: {
    organizationId: string;
    unpaidCount: number;
    warningThreshold: number;
    suspensionThreshold: number;
    overdueInvoiceIds: string[];
    warnedAt: string;
  }): Promise<void>;
}

/** Réglages lus à chaque décision (16.1) et règles de reprise des séances (R-SU-03). */
export interface OrganizationStandingSettings {
  thresholds(): Promise<UnpaidThresholds>;
  /** Délai minimum avant une séance (`firstSessionLeadHours`, 48 h par défaut). */
  firstSessionLeadHours(): Promise<number>;
  /** Jours exclus du programme et jours fériés (AAAA-MM-JJ, Porto-Novo). */
  excludedDays(programId: string): Promise<ReadonlySet<string>>;
}
