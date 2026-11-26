import { type Period } from '../../domain/statement';
import { type PageRequest } from '../cases/ports';
import { type Holder } from '../ports';

/**
 * Ports des relevés mensuels (R-CO-05, ADR-060 point 11) : un relevé par dossier et par mois, son PDF
 * (modèle `recovery_statement` de document) et la facture de commission du mois émise par billing
 * (`billing.commission_invoice.issued`, ADR-064), qui peut arriver avant ou après le relevé.
 */

/** Relevé d'un dossier pour un mois (table `statements`). */
export interface StatementRecord {
  id: string;
  caseId: string;
  caseNumber: string;
  creditor: Holder;
  period: Period;
  collected: number;
  commission: number;
  costs: number;
  remitted: number;
  documentId: string;
  documentNumber: string;
  /** Facture de commission de billing du même créancier et du même mois ; null tant qu'elle n'est pas reçue. */
  invoiceId: string | null;
  issuedAt: Date;
}

/** Facture mensuelle de commission reçue de billing (identifiants et période seulement). */
export interface CommissionInvoiceRecord {
  id: string;
  number: string;
  creditor: Holder;
  period: Period;
  issuedAt: Date;
}

export interface StatementFilter {
  period: Period | null;
  caseId: string | null;
}

export interface StatementStore {
  /**
   * Dossiers dont un encaissement a été crédité au créancier pendant le mois (`creditedAt` dans
   * [start, end), commission retenue) et qui n'ont pas encore de relevé pour ce mois : lots triés par
   * identifiant, repris après `afterId`.
   */
  casesToState(
    period: Period,
    bounds: { start: Date; end: Date },
    afterId: string | null,
    limit: number,
  ): Promise<string[]>;
  /**
   * Enregistre le relevé ; false s'il en existe déjà un pour ce dossier et ce mois (autre instance).
   * La facture du mois, reçue entre-temps, y est rattachée dans la même transaction.
   */
  insert(statement: StatementRecord): Promise<boolean>;
  /**
   * Facture reçue (inbox) : gardée, et rattachée aux relevés du créancier pour ce mois. `duplicate` :
   * événement déjà traité.
   */
  recordInvoice(
    invoice: CommissionInvoiceRecord,
    inbox: { eventId: string; consumer: string },
  ): Promise<{ outcome: 'recorded' | 'duplicate'; statements: number }>;
  /** Relevés du créancier, les plus récents d'abord (identifiant décroissant). */
  list(
    creditor: Holder,
    filter: StatementFilter,
    page: PageRequest,
  ): Promise<{ items: StatementRecord[]; nextCursor: string | null }>;
}
