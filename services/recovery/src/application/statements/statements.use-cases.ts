import { type ClosureReason } from '../../domain/case';
import { type CollectionSource } from '../../domain/collection';
import {
  isPeriod,
  type Period,
  periodBounds,
  periodsToState,
  type StatementMovement,
  statementMovements,
} from '../../domain/statement';
import { STAGE_LABELS } from '../amicable/amicable-rules';
import { requireOwnCase } from '../cases/case-access';
import { amountDue, debtorDisplayName, requirePage } from '../cases/case-rules';
import { displayNames } from '../cases/case-views';
import { caseSubject, requireCaseId } from '../cases/creditor-cases.use-cases';
import { type CaseRepository, type RecoveryCaseRecord } from '../cases/ports';
import { type CollectionRecord, type MoneyStore } from '../money/money.ports';
import { mainDebtor } from '../money/money-rules';
import { type Clock, type Directory, type Documents, type Holder, type IdGenerator } from '../ports';
import { currentCreditor } from '../shared/access';
import { RecoveryErrors } from '../shared/errors';
import { type StatementRecord, type StatementStore } from './statements.ports';

/** Dépendances des relevés mensuels : dossiers, encaissements (lot R3), relevés, document, identity. */
export interface StatementDeps {
  cases: CaseRepository;
  money: Pick<MoneyStore, 'collections'>;
  statements: StatementStore;
  documents: Documents;
  directory: Directory;
  clock: Clock;
  ids: IdGenerator;
}

/** Modèle du relevé chez document (ADR-060 point 12) : REL, sans signature. */
export const STATEMENT_TEMPLATE = 'recovery_statement';
/** Mois écoulés repris par la tâche en plus du dernier (tâche arrêtée quelques jours). */
export const STATEMENT_CATCH_UP_MONTHS = 2;
/** Dossiers traités par lot ; un passage parcourt au plus `MAX_PAGES` lots par mois. */
const BATCH = 50;
const MAX_PAGES = 20;
/** Mouvements d'un relevé (borne du modèle v1). */
const MAX_MOVEMENTS = 500;

const SOURCE_LABELS: Record<CollectionSource, string> = {
  payment_link: 'Paiement en ligne du débiteur (Mobile Money ou carte)',
  offline_cash: 'Paiement en espèces au guichet de KSP',
  offline_transfer: 'Virement du débiteur',
  partner: 'Encaissement par le partenaire',
  direct_to_creditor: 'Paiement reçu directement par le créancier',
};

const CLOSURE_LABELS: Record<ClosureReason, string> = {
  paid: 'Clos : montant dû payé',
  settlement_executed: 'Clos : accord transactionnel exécuté',
  dispute_upheld: 'Clos : contestation fondée',
  abandoned_by_creditor: 'Clos : arrêté par le créancier',
  unrecoverable: 'Clos : créance irrécouvrable',
  prescribed: 'Clos : créance prescrite',
};

/** Statut du dossier en clair (« En cours : relance amiable »), 80 caractères au plus. */
export function situationLabel(record: RecoveryCaseRecord): string {
  if (record.status === 'closed') return record.closureReason ? CLOSURE_LABELS[record.closureReason] : 'Clos';
  if (record.status === 'suspended') return 'Suspendu : contestation du débiteur';
  return record.stage ? `En cours : ${STAGE_LABELS[record.stage]}` : 'En cours';
}

const oneLine = (text: string, max: number, fallback: string) =>
  text.replace(/\s+/g, ' ').trim().slice(0, max) || fallback;

/** Clôtures qui ne laissent rien à payer au débiteur : solde abandonné, contestation fondée. */
const NOTHING_OWED: ReadonlySet<ClosureReason> = new Set(['settlement_executed', 'dispute_upheld']);

/**
 * Situation du dossier en fin de mois : total encaissé jusque-là (paiements directs compris, hors
 * trop-perçu) et reste dû, reconstitué en rajoutant au dû d'aujourd'hui ce qui a été imputé depuis
 * (rien après un accord transactionnel exécuté ou une contestation fondée).
 */
function situation(record: RecoveryCaseRecord, collections: readonly CollectionRecord[], end: Date) {
  let collectedToDate = 0;
  let imputedSince = 0;
  for (const collection of collections) {
    if (collection.collectedAt < end) collectedToDate += collection.gross - collection.overpaid;
    else
      imputedSince +=
        collection.allocatedCosts + collection.allocatedInterests + collection.allocatedPrincipal;
  }
  const owed = record.closureReason && NOTHING_OWED.has(record.closureReason) ? 0 : amountDue(record);
  return { collectedToDate, outstanding: owed + imputedSince };
}

/** Variables du modèle `recovery_statement` v1 (service document). */
export function statementVariables(input: {
  record: RecoveryCaseRecord;
  creditorName: string;
  period: Period;
  movements: readonly StatementMovement[];
  collections: readonly CollectionRecord[];
}): Record<string, unknown> {
  const { record, period, movements } = input;
  const debtor = mainDebtor(record);
  const { end } = periodBounds(period);
  const state = situation(record, input.collections, end);
  const collected = movements.reduce((sum, movement) => sum + movement.collected, 0);
  return {
    caseReference: record.number,
    creditor: { name: oneLine(input.creditorName, 200, 'Créancier') },
    debtor: { name: oneLine(debtor ? debtorDisplayName(debtor) : '', 200, 'Débiteur') },
    month: period,
    movements: movements.map((movement) => ({
      date: movement.day,
      label: SOURCE_LABELS[movement.source],
      collected: movement.collected,
      commission: movement.commission,
      costs: movement.costs,
      remitted: movement.remitted,
    })),
    situation: {
      status: situationLabel(record),
      collectedToDate: Math.max(state.collectedToDate, collected),
      outstanding: state.outstanding,
    },
  };
}

export interface StatementsReport {
  issued: number;
  /** Dossiers en erreur (document ou identity injoignable), repris au passage suivant. */
  failed: number;
}

/**
 * Relevés mensuels (R-CO-05, ADR-060 points 11 et 17) : chaque mois écoulé, un relevé par dossier dont
 * un encaissement a été crédité au créancier pendant ce mois — encaissé, commission, frais retenus,
 * reversé —, avec son PDF (`recovery_statement`, clé stable par dossier et par mois) et la facture de
 * commission du mois de billing, rattachée dès qu'elle est connue. Plusieurs instances peuvent tourner :
 * un seul relevé par dossier et par mois (index unique), document idempotent.
 */
export class IssueMonthlyStatementsUseCase {
  constructor(private readonly deps: StatementDeps) {}

  async execute(): Promise<StatementsReport> {
    const report: StatementsReport = { issued: 0, failed: 0 };
    for (const period of periodsToState(this.deps.clock.now(), STATEMENT_CATCH_UP_MONTHS)) {
      const bounds = periodBounds(period);
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const caseIds = await this.deps.statements.casesToState(period, bounds, after, BATCH);
        for (const caseId of caseIds) {
          try {
            if (await this.issue(caseId, period)) report.issued += 1;
          } catch {
            report.failed += 1;
          }
        }
        if (caseIds.length < BATCH) break;
        after = caseIds[caseIds.length - 1]!;
      }
    }
    return report;
  }

  /** Relevé d'un dossier pour un mois ; false s'il n'y a rien à relever ou s'il existe déjà. */
  async issue(caseId: string, period: Period): Promise<boolean> {
    const record = await this.deps.cases.find(caseId);
    if (!record) return false;
    const collections = await this.deps.money.collections(caseId);
    const { movements, totals } = statementMovements(collections, period);
    if (movements.length === 0) return false;
    const names = await displayNames(this.deps.directory, [record.creditor], []);
    const creditorName = names.holder(record.creditor);
    if (!creditorName) throw RecoveryErrors.dependencyUnavailable('identity');
    const document = await this.deps.documents.generate({
      template: STATEMENT_TEMPLATE,
      variables: statementVariables({
        record,
        creditorName,
        period,
        movements: movements.slice(0, MAX_MOVEMENTS),
        collections,
      }),
      subject: caseSubject(record.id),
      ownerId: record.createdBy,
      idempotencyKey: `recovery:statement:${record.id}:${period}`,
    });
    return this.deps.statements.insert({
      id: this.deps.ids.next(),
      caseId: record.id,
      caseNumber: record.number,
      creditor: record.creditor,
      period,
      ...totals,
      documentId: document.id,
      documentNumber: document.number,
      invoiceId: null,
      issuedAt: this.deps.clock.now(),
    });
  }
}

/**
 * Relevés du créancier connecté (ListMyStatements, R-CO-05 ; 14.1 « Reversements ») : par mois et par
 * dossier, les plus récents d'abord, avec le PDF et la facture de commission de billing. Un membre
 * lecteur de l'organisation les consulte aussi.
 */
export class ListMyStatementsUseCase {
  constructor(private readonly deps: Pick<StatementDeps, 'cases' | 'statements'>) {}

  async execute(input: {
    period: string;
    caseId: string;
    page?: { limit?: number; cursor?: string };
  }): Promise<{ items: StatementRecord[]; nextCursor: string | null }> {
    const creditor = currentCreditor();
    const page = requirePage(input.page);
    if (input.period && !isPeriod(input.period)) {
      throw RecoveryErrors.invalid('period', 'Mois « AAAA-MM » attendu.');
    }
    let caseId: string | null = null;
    if (input.caseId) {
      caseId = requireOwnCase(await this.deps.cases.find(requireCaseId(input.caseId)), creditor).id;
    }
    return this.deps.statements.list(creditor.holder, { period: input.period || null, caseId }, page);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Consommateur de l'inbox pour `billing.commission_invoice.issued`. */
export const COMMISSION_INVOICE_CONSUMER = 'recovery.billing.commission_invoice.issued';

/**
 * Facture mensuelle de commission émise par billing (`billing.commission_invoice.issued`, ADR-064) :
 * gardée et rattachée aux relevés du créancier pour le même mois (`invoiceId`), qu'ils soient déjà
 * produits ou à venir. Idempotent (inbox) ; un événement mal formé est ignoré.
 */
export class RecordCommissionInvoiceUseCase {
  constructor(private readonly deps: Pick<StatementDeps, 'statements'>) {}

  async execute(input: {
    eventId: string;
    invoiceId: string;
    invoiceNumber: string;
    creditor: { type: string; id: string };
    period: string;
    issuedAt: string;
  }): Promise<{ outcome: 'recorded' | 'duplicate' | 'ignored'; statements: number }> {
    const type = input.creditor?.type;
    const issuedAt = new Date(input.issuedAt);
    if (
      !UUID.test(input.eventId ?? '') ||
      !UUID.test(input.invoiceId ?? '') ||
      !UUID.test(input.creditor?.id ?? '') ||
      (type !== 'user' && type !== 'organization') ||
      !isPeriod(input.period ?? '') ||
      Number.isNaN(issuedAt.getTime())
    ) {
      return { outcome: 'ignored', statements: 0 };
    }
    const creditor: Holder = { type, id: input.creditor.id.toLowerCase() };
    return this.deps.statements.recordInvoice(
      {
        id: input.invoiceId.toLowerCase(),
        number: input.invoiceNumber,
        creditor,
        period: input.period,
        issuedAt,
      },
      { eventId: input.eventId, consumer: COMMISSION_INVOICE_CONSUMER },
    );
  }
}
