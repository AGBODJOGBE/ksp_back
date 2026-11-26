import { type PageRequest } from '../cases/ports';
import { type CollectionRecord } from '../money/money.ports';
import { type Holder } from '../ports';
import {
  type CommissionInvoiceRecord,
  type StatementFilter,
  type StatementRecord,
  type StatementStore,
} from '../statements/statements.ports';

/** Doublures en mémoire des relevés mensuels (R-CO-05). */

const sameHolder = (a: Holder, b: Holder) => a.type === b.type && a.id === b.id;

/**
 * Relevés et factures de commission en mémoire, branchés sur les encaissements du dépôt de l'argent :
 * un seul relevé par dossier et par mois, facture rattachée à l'enregistrement comme à sa réception.
 */
export class MemoryStatementStore implements StatementStore {
  readonly statements = new Map<string, StatementRecord>();
  readonly invoices = new Map<string, CommissionInvoiceRecord>();
  readonly inbox = new Set<string>();

  constructor(private readonly money: { collectionsById: ReadonlyMap<string, CollectionRecord> }) {}

  async casesToState(
    period: string,
    bounds: { start: Date; end: Date },
    afterId: string | null,
    limit: number,
  ): Promise<string[]> {
    const stated = new Set(
      [...this.statements.values()].filter((s) => s.period === period).map((s) => s.caseId),
    );
    const caseIds = new Set(
      [...this.money.collectionsById.values()]
        .filter(
          (c) =>
            c.settlement === 'deducted' &&
            c.gross > c.overpaid &&
            c.creditedAt !== null &&
            c.creditedAt >= bounds.start &&
            c.creditedAt < bounds.end,
        )
        .map((c) => c.caseId),
    );
    return [...caseIds]
      .filter((id) => !stated.has(id) && (afterId === null || id > afterId))
      .sort()
      .slice(0, limit);
  }

  private invoiceFor(creditor: Holder, period: string): CommissionInvoiceRecord | undefined {
    return [...this.invoices.values()].find(
      (invoice) => sameHolder(invoice.creditor, creditor) && invoice.period === period,
    );
  }

  async insert(statement: StatementRecord): Promise<boolean> {
    if (
      [...this.statements.values()].some(
        (other) => other.caseId === statement.caseId && other.period === statement.period,
      )
    ) {
      return false;
    }
    const invoice = this.invoiceFor(statement.creditor, statement.period);
    this.statements.set(statement.id, { ...structuredClone(statement), invoiceId: invoice?.id ?? null });
    return true;
  }

  async recordInvoice(invoice: CommissionInvoiceRecord, inbox: { eventId: string; consumer: string }) {
    const key = `${inbox.eventId}:${inbox.consumer}`;
    if (this.inbox.has(key)) return { outcome: 'duplicate' as const, statements: 0 };
    this.inbox.add(key);
    if (!this.invoiceFor(invoice.creditor, invoice.period)) {
      this.invoices.set(invoice.id, structuredClone(invoice));
    }
    let statements = 0;
    for (const statement of this.statements.values()) {
      if (
        sameHolder(statement.creditor, invoice.creditor) &&
        statement.period === invoice.period &&
        statement.invoiceId === null
      ) {
        statement.invoiceId = invoice.id;
        statements += 1;
      }
    }
    return { outcome: 'recorded' as const, statements };
  }

  async list(creditor: Holder, filter: StatementFilter, page: PageRequest) {
    const items = [...this.statements.values()]
      .filter(
        (statement) =>
          sameHolder(statement.creditor, creditor) &&
          (filter.period === null || statement.period === filter.period) &&
          (filter.caseId === null || statement.caseId === filter.caseId) &&
          (page.cursor === null || statement.id < page.cursor),
      )
      .sort((a, b) => b.id.localeCompare(a.id));
    const pageItems = items.slice(0, page.limit).map((statement) => structuredClone(statement));
    return {
      items: pageItems,
      nextCursor: items.length > page.limit ? pageItems[pageItems.length - 1]!.id : null,
    };
  }
}
