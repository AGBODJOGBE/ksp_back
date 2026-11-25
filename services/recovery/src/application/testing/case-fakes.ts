import { AppError } from '@ksp/platform';
import { type ImportRow } from '../../domain/import';
import { stageGroup } from '../../domain/case';
import { CaseErrors } from '../cases/case-errors';
import { feeSettlementPending } from '../cases/case-fees';
import { amountDue, debtorDisplayName, priorPayments } from '../cases/case-rules';
import {
  type CaseAuditEntry,
  type CaseChanges,
  type CaseImportRecord,
  type CaseImportRepository,
  type CaseListFilter,
  type CaseQueries,
  type CaseRepository,
  type CaseSummaryRecord,
  type CreditorDashboardFigures,
  type CreditorPreferences,
  type CreditorPreferencesStore,
  type CreditorProfile,
  type CreditorProfiles,
  type EvidenceEntryData,
  type OverviewFigures,
  type PageRequest,
  type RecoveryCaseRecord,
  type RecoveryOutboxMessage,
  type SaveOutcome,
  type SimilarCaseProbe,
  type SpreadsheetReader,
  type StaffScope,
  type StageTransitionData,
  type StoredCreditorPreferences,
} from '../cases/ports';
import {
  type Directory,
  type Documents,
  type Files,
  type GeneratedDocument,
  type Holder,
  type PersonSummary,
  type WalletGateway,
} from '../ports';

/** Doublures en mémoire des ports des dossiers (tests des cas d'usage, R2 à R5). */

const sameHolder = (a: Holder, b: Holder) => a.type === b.type && a.id === b.id;
const OPEN = new Set(['draft', 'awaiting_fee', 'under_review', 'info_requested', 'active', 'suspended']);
const SUBMITTED = new Set(['under_review', 'info_requested', 'active', 'suspended', 'closed']);
const IN_PROGRESS = new Set(['under_review', 'info_requested', 'active', 'suspended']);

export function summaryOf(record: RecoveryCaseRecord): CaseSummaryRecord {
  return {
    id: record.id,
    number: record.number,
    kind: record.kind,
    status: record.status,
    stage: record.stage,
    creditor: record.creditor,
    debtorName: record.debtors[0] ? debtorDisplayName(record.debtors[0]) : '',
    principal: record.principal,
    interests: record.interests,
    costs: record.costs,
    paid: record.paid,
    score: record.score?.value ?? null,
    assignedAgentId: record.assignedAgentId,
    createdAt: record.createdAt,
    submittedAt: record.submittedAt,
    infoRequestedAt: record.infoRequestedAt,
    lastActionAt: record.lastActionAt,
  };
}

export class MemoryCaseRepository implements CaseRepository {
  readonly cases = new Map<string, RecoveryCaseRecord>();
  readonly evidence: EvidenceEntryData[] = [];
  readonly events: RecoveryOutboxMessage[] = [];
  readonly audit: CaseAuditEntry[] = [];
  readonly transitions: (StageTransitionData & { caseId: string })[] = [];
  readonly inbox = new Set<string>();
  readonly deleted: string[] = [];
  /** Écritures concurrentes simulées : les prochaines sauvegardes rendent `stale`. */
  staleSaves = 0;
  private sequence = 0;

  async find(id: string) {
    const record = this.cases.get(id);
    return record ? structuredClone(record) : null;
  }

  async findByIdempotencyKey(creditor: Holder, key: string) {
    const record = [...this.cases.values()].find(
      (candidate) => candidate.idempotencyKey === key && sameHolder(candidate.creditor, creditor),
    );
    return record ? structuredClone(record) : null;
  }

  /** Numéro tiré de la séquence, comme la base. */
  insert(record: RecoveryCaseRecord): RecoveryCaseRecord {
    this.sequence += 1;
    const stored = {
      ...structuredClone(record),
      number: `RC-${String(this.sequence).padStart(6, '0')}`,
      version: 0,
    };
    this.cases.set(stored.id, stored);
    return stored;
  }

  async create(record: RecoveryCaseRecord, changes: CaseChanges) {
    const taken =
      this.cases.has(record.id) ||
      (record.idempotencyKey !== null &&
        (await this.findByIdempotencyKey(record.creditor, record.idempotencyKey)));
    if (taken) return 'duplicate' as const;
    const stored = this.insert(record);
    this.write(stored.id, changes);
    return structuredClone(stored);
  }

  async save(
    record: RecoveryCaseRecord,
    changes: CaseChanges,
    options: { content?: boolean; inbox?: { eventId: string; consumer: string } } = {},
  ): Promise<SaveOutcome> {
    if (this.staleSaves > 0) {
      this.staleSaves -= 1;
      return 'stale';
    }
    const current = this.cases.get(record.id);
    if (!current || current.version !== record.version) return 'stale';
    if (options.inbox) {
      const key = `${options.inbox.eventId}:${options.inbox.consumer}`;
      if (this.inbox.has(key)) return 'duplicate';
      this.inbox.add(key);
    }
    this.cases.set(record.id, { ...structuredClone(record), version: record.version + 1 });
    this.write(record.id, changes);
    return 'saved';
  }

  private write(caseId: string, changes: CaseChanges) {
    this.evidence.push(...structuredClone(changes.evidence));
    this.events.push(...structuredClone(changes.events));
    this.audit.push(...structuredClone(changes.audit));
    this.transitions.push(...changes.stageTransitions.map((transition) => ({ ...transition, caseId })));
  }

  async deleteUnpaid(record: RecoveryCaseRecord, audit: CaseAuditEntry) {
    const current = this.cases.get(record.id);
    if (
      !current ||
      current.version !== record.version ||
      !['draft', 'awaiting_fee'].includes(current.status) ||
      current.fee.paidAt
    ) {
      return false;
    }
    this.cases.delete(record.id);
    for (let i = this.evidence.length - 1; i >= 0; i -= 1) {
      if (this.evidence[i]!.caseId === record.id) this.evidence.splice(i, 1);
    }
    this.audit.push(audit);
    this.deleted.push(record.id);
    return true;
  }

  async findSimilarOpen(creditor: Holder, probe: SimilarCaseProbe, excludeCaseId: string | null) {
    const contacts = new Set([...probe.phones, ...probe.emails]);
    const references = new Set(probe.references);
    return [...this.cases.values()]
      .filter(
        (record) =>
          record.id !== excludeCaseId &&
          sameHolder(record.creditor, creditor) &&
          OPEN.has(record.status) &&
          record.debtors.some((debtor) => debtor.contacts.some((contact) => contacts.has(contact.value))) &&
          record.claims.some((claim) => references.has(claim.reference)),
      )
      .map(summaryOf);
  }

  async listUnpaidCreatedBefore(before: Date, limit: number) {
    return [...this.cases.values()]
      .filter(
        (r) =>
          (r.status === 'draft' || r.status === 'awaiting_fee') && !r.fee.paidAt && r.createdAt <= before,
      )
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async listInfoRequestedBefore(before: Date, limit: number) {
    return [...this.cases.values()]
      .filter(
        (r) => r.status === 'info_requested' && r.infoRequestedAt !== null && r.infoRequestedAt <= before,
      )
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  async listPendingFeeSettlements(limit: number) {
    return [...this.cases.values()]
      .filter(feeSettlementPending)
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}

/** Lectures calculées sur le dépôt en mémoire ; encaissements et décisions posés par les tests. */
export class MemoryCaseQueries implements CaseQueries {
  /** Encaissé (hors trop-perçu) par dossier, et par groupe d'étapes. */
  readonly collected = new Map<string, { amount: number; stageGroup: string }[]>();
  readonly pendingDecisions = new Map<string, number>();

  constructor(private readonly repository: MemoryCaseRepository) {}

  private matches(record: RecoveryCaseRecord, filter: CaseListFilter): boolean {
    const summary = summaryOf(record);
    return (
      (!filter.creditor || sameHolder(record.creditor, filter.creditor)) &&
      (!filter.statuses || filter.statuses.includes(record.status)) &&
      (!filter.stages || (record.stage !== null && filter.stages.includes(record.stage))) &&
      (!filter.kinds || filter.kinds.includes(record.kind)) &&
      (!filter.assignedAgentId || record.assignedAgentId === filter.assignedAgentId) &&
      (!filter.creditorId || record.creditor.id === filter.creditorId) &&
      (!filter.communeKey || record.communeKey === filter.communeKey) &&
      (!filter.number || record.number.includes(filter.number)) &&
      (!filter.debtorNameTokens ||
        filter.debtorNameTokens.every((token) => summary.debtorName.toLowerCase().includes(token))) &&
      (!filter.idleSince || (record.lastActionAt !== null && record.lastActionAt <= filter.idleSince)) &&
      (!filter.prescriptionBefore ||
        (record.prescriptionDate !== null && record.prescriptionDate <= filter.prescriptionBefore))
    );
  }

  async list(filter: CaseListFilter, page: PageRequest) {
    const all = [...this.repository.cases.values()]
      .filter((record) => this.matches(record, filter))
      .sort((a, b) => b.number.localeCompare(a.number));
    const start = page.cursor ? all.findIndex((record) => record.number === page.cursor) + 1 : 0;
    const items = all.slice(start, start + page.limit);
    return {
      items: items.map(summaryOf),
      nextCursor: start + page.limit < all.length ? items[items.length - 1]!.number : null,
      total: all.length,
    };
  }

  async journal(caseId: string, options: { includeInternal: boolean }, page: PageRequest) {
    const all = this.repository.evidence
      .filter((entry) => entry.caseId === caseId && (options.includeInternal || !entry.internal))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id));
    const start = page.cursor ? all.findIndex((entry) => entry.id === page.cursor) + 1 : 0;
    const items = all.slice(start, start + page.limit);
    return { items, nextCursor: start + page.limit < all.length ? items[items.length - 1]!.id : null };
  }

  async stageHistory(caseId: string) {
    return this.repository.transitions
      .filter((transition) => transition.caseId === caseId)
      .map(({ caseId: _caseId, ...transition }) => transition);
  }

  private recovered(caseId: string) {
    return (this.collected.get(caseId) ?? []).reduce((sum, item) => sum + item.amount, 0);
  }

  async creditorDashboard(creditor: Holder): Promise<CreditorDashboardFigures> {
    const cases = [...this.repository.cases.values()].filter((record) =>
      sameHolder(record.creditor, creditor),
    );
    const submitted = cases.filter((record) => SUBMITTED.has(record.status));
    const stages = new Map<string, number>();
    for (const record of cases) {
      if ((record.status === 'active' || record.status === 'suspended') && record.stage) {
        stages.set(record.stage, (stages.get(record.stage) ?? 0) + 1);
      }
    }
    return {
      entrusted: submitted.reduce(
        (sum, r) => sum + r.principal + r.interests + r.costs - priorPayments(r),
        0,
      ),
      recovered: submitted.reduce((sum, record) => sum + this.recovered(record.id), 0),
      outstanding: submitted
        .filter((record) => record.status !== 'closed')
        .reduce((sum, record) => sum + amountDue(record), 0),
      casesByStage: [...stages].map(([stage, count]) => ({ stage: stage as never, count })),
      pendingDecisions: cases.reduce((sum, record) => sum + (this.pendingDecisions.get(record.id) ?? 0), 0),
      upcomingInstallments: [],
    };
  }

  async overview(
    scope: StaffScope,
    _today: string,
    options: { idleSince: Date; prescriptionBefore: string },
  ): Promise<OverviewFigures> {
    const cases = [...this.repository.cases.values()].filter(
      (record) =>
        (scope.agentId === null || record.assignedAgentId === scope.agentId) &&
        (scope.communeKey === null || record.communeKey === scope.communeKey),
    );
    const submitted = cases.filter((record) => SUBMITTED.has(record.status));
    const count = (keys: string[]) => {
      const counts = new Map<string, number>();
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
      return [...counts].map(([stage, value]) => ({ stage, count: value }));
    };
    const active = cases.filter((record) => record.status === 'active' || record.status === 'suspended');
    const byGroup = new Map<string, number>();
    for (const record of submitted) {
      for (const item of this.collected.get(record.id) ?? []) {
        byGroup.set(item.stageGroup, (byGroup.get(item.stageGroup) ?? 0) + item.amount);
      }
    }
    const agents = new Map<string, { openCases: number; entrusted: number; recovered: number }>();
    for (const record of submitted) {
      if (!record.assignedAgentId) continue;
      const agent = agents.get(record.assignedAgentId) ?? { openCases: 0, entrusted: 0, recovered: 0 };
      if (record.status !== 'closed') agent.openCases += 1;
      agent.entrusted += record.principal + record.interests + record.costs - priorPayments(record);
      agent.recovered += this.recovered(record.id);
      agents.set(record.assignedAgentId, agent);
    }
    return {
      casesByStage: count(active.map((record) => record.stage!)),
      casesByKind: count(
        cases.filter((record) => IN_PROGRESS.has(record.status)).map((record) => record.kind),
      ),
      entrusted: submitted.reduce(
        (sum, r) => sum + r.principal + r.interests + r.costs - priorPayments(r),
        0,
      ),
      recovered: submitted.reduce((sum, record) => sum + this.recovered(record.id), 0),
      recoveredByStageGroup: [...byGroup].map(([stage, amount]) => ({ stage, amount })),
      agents: [...agents].map(([agentId, figures]) => ({ agentId, ...figures })),
      installmentsDueToday: 0,
      promisesToCheck: 0,
      idleCases: active.filter(
        (record) => record.lastActionAt !== null && record.lastActionAt <= options.idleSince,
      ).length,
      prescriptionsNear: active.filter(
        (record) => record.prescriptionDate !== null && record.prescriptionDate <= options.prescriptionBefore,
      ).length,
      reviewQueue: cases.filter((record) => record.status === 'under_review').length,
      offlinePaymentsToApprove: 0,
    };
  }
}

/** Groupe d'étapes d'un dossier, pour poser des encaissements dans les tests. */
export const groupOf = (record: RecoveryCaseRecord) => stageGroup(record.stage);

export class MemoryCaseImportRepository implements CaseImportRepository {
  readonly imports = new Map<string, CaseImportRecord>();

  constructor(private readonly cases: MemoryCaseRepository) {}

  async find(id: string) {
    const record = this.imports.get(id);
    return record ? structuredClone(record) : null;
  }

  async findByIdempotencyKey(creditor: Holder, key: string) {
    const record = [...this.imports.values()].find(
      (candidate) => candidate.idempotencyKey === key && sameHolder(candidate.creditor, creditor),
    );
    return record ? structuredClone(record) : null;
  }

  async create(record: CaseImportRecord) {
    if (this.imports.has(record.id)) return 'duplicate' as const;
    this.imports.set(record.id, structuredClone(record));
    return 'created' as const;
  }

  async saveLines(record: CaseImportRecord) {
    const current = this.imports.get(record.id);
    if (!current || current.version !== record.version) return false;
    this.imports.set(record.id, { ...structuredClone(record), version: record.version + 1 });
    return true;
  }

  async confirm(
    record: CaseImportRecord,
    cases: readonly { record: RecoveryCaseRecord; changes: CaseChanges }[],
  ) {
    const current = this.imports.get(record.id);
    if (!current || current.version !== record.version) return 'stale' as const;
    const created = cases.map(({ record: draft, changes }) => {
      const stored = this.cases.insert(draft);
      this.cases.evidence.push(...structuredClone(changes.evidence));
      return structuredClone(stored);
    });
    this.imports.set(record.id, { ...structuredClone(record), version: record.version + 1 });
    return created;
  }
}

export class MemoryCreditorPreferences implements CreditorPreferencesStore {
  readonly rows = new Map<string, StoredCreditorPreferences>();

  async get(creditor: Holder) {
    return structuredClone(this.rows.get(`${creditor.type}:${creditor.id}`) ?? null);
  }

  async save(creditor: Holder, preferences: CreditorPreferences, by: string, at: Date) {
    this.rows.set(`${creditor.type}:${creditor.id}`, {
      ...structuredClone(preferences),
      updatedAt: at,
      updatedBy: by,
    });
  }
}

export class MemoryCreditorProfiles implements CreditorProfiles {
  profileOf: CreditorProfile = {
    name: 'Awa Houngbo',
    kind: 'individual',
    identification: null,
    address: null,
    phone: '+2290197000001',
    email: null,
    representative: null,
  };

  async profile() {
    return this.profileOf;
  }
}

/** Tableurs posés par les tests, par fichier ; un fichier inconnu est illisible. */
export class MemorySpreadsheets implements SpreadsheetReader {
  readonly files = new Map<string, ImportRow[]>();
  readonly reads: { fileId: string; subject: { type: string; id: string }; ownerId: string }[] = [];

  async read(input: { fileId: string; subject: { type: string; id: string }; ownerId: string }) {
    this.reads.push(input);
    const rows = this.files.get(input.fileId);
    if (!rows) throw CaseErrors.importFileInvalid('unreadable');
    return structuredClone(rows);
  }
}

/** Portefeuille simulé comme wallet : débits idempotents par clé, jamais partiels ; un remboursement par débit. */
export class MemoryWallet implements WalletGateway {
  readonly balances = new Map<string, number>();
  readonly debits = new Map<
    string,
    {
      transactionId: string;
      holder: Holder;
      amount: number;
      objectType: string;
      objectId: string;
      description: string;
    }
  >();
  readonly refunds = new Map<string, { transactionId: string; reason: string }>();
  /** Panne simulée : les prochains appels lèvent RECOVERY_DEPENDENCY_UNAVAILABLE. */
  unavailable = 0;
  private counter = 0;

  private fail() {
    if (this.unavailable > 0) {
      this.unavailable -= 1;
      throw AppError.unavailable('RECOVERY_DEPENDENCY_UNAVAILABLE', 'wallet indisponible', {
        service: 'wallet',
      });
    }
  }

  async debit(input: Parameters<WalletGateway['debit']>[0]) {
    this.fail();
    const known = this.debits.get(input.idempotencyKey);
    if (known) return { transactionId: known.transactionId, created: false };
    const balance = this.balances.get(input.holder.id) ?? 0;
    if (balance < input.amount) {
      throw AppError.precondition('WALLET_INSUFFICIENT_FUNDS', 'Solde du portefeuille insuffisant.', {
        balance: { amount: balance, currency: 'XOF' },
        missing: { amount: input.amount - balance, currency: 'XOF' },
      });
    }
    this.counter += 1;
    const transactionId = `0192f1c4-0000-7000-9000-${this.counter.toString(16).padStart(12, '0')}`;
    this.balances.set(input.holder.id, balance - input.amount);
    this.debits.set(input.idempotencyKey, {
      transactionId,
      holder: input.holder,
      amount: input.amount,
      objectType: input.objectType,
      objectId: input.objectId,
      description: input.description,
    });
    return { transactionId, created: true };
  }

  async refund(input: { debitTransactionId: string; reason: string }) {
    this.fail();
    const known = this.refunds.get(input.debitTransactionId);
    if (known) return { transactionId: known.transactionId };
    const debit = [...this.debits.values()].find(
      (candidate) => candidate.transactionId === input.debitTransactionId,
    );
    if (!debit) throw AppError.notFound('WALLET_TRANSACTION_NOT_FOUND', 'Débit introuvable.');
    this.counter += 1;
    const transactionId = `0192f1c4-0000-7000-9000-${this.counter.toString(16).padStart(12, '0')}`;
    this.balances.set(debit.holder.id, (this.balances.get(debit.holder.id) ?? 0) + debit.amount);
    this.refunds.set(input.debitTransactionId, { transactionId, reason: input.reason });
    return { transactionId };
  }

  async recordCollection(): Promise<never> {
    throw new Error('recordCollection ne devrait pas être appelé en R2');
  }

  async reverseCollection(): Promise<never> {
    throw new Error('reverseCollection ne devrait pas être appelé en R2');
  }

  async balance(holder: Holder) {
    return { balance: 0, prepaidBalance: this.balances.get(holder.id) ?? 0 };
  }
}

/** Documents simulés : production et demande de signature idempotentes par clé. */
export class MemoryDocuments implements Documents {
  readonly generated = new Map<string, GeneratedDocument & { variables: Record<string, unknown> }>();
  readonly signatures = new Map<
    string,
    { signatureId: string; documentId: string; notice?: string; userId?: string }
  >();
  private counter = 0;

  async generate(input: Parameters<Documents['generate']>[0]) {
    const known = this.generated.get(input.idempotencyKey);
    if (known) return { id: known.id, number: known.number, status: known.status, fileId: known.fileId };
    this.counter += 1;
    const suffix = this.counter.toString(16).padStart(12, '0');
    const document = {
      id: `0192f1c4-0000-7000-a000-${suffix}`,
      number: `MAN-2026-${String(this.counter).padStart(6, '0')}`,
      status: 'draft',
      fileId: `0192f1c4-0000-7000-b000-${suffix}`,
      variables: structuredClone(input.variables),
    };
    this.generated.set(input.idempotencyKey, document);
    return { id: document.id, number: document.number, status: document.status, fileId: document.fileId };
  }

  async requestSignature(input: Parameters<Documents['requestSignature']>[0]) {
    const known = this.signatures.get(input.idempotencyKey);
    if (known) return { signatureId: known.signatureId, status: 'pending' };
    this.counter += 1;
    const signatureId = `0192f1c4-0000-7000-c000-${this.counter.toString(16).padStart(12, '0')}`;
    this.signatures.set(input.idempotencyKey, {
      signatureId,
      documentId: input.documentId,
      ...(input.notice ? { notice: input.notice } : {}),
      ...(input.signer.userId ? { userId: input.signer.userId } : {}),
    });
    return { signatureId, status: 'pending' };
  }
}

/** Fichiers simulés : rattachement idempotent pour le même objet, refusé pour un autre (comme file). */
export class MemoryFiles implements Files {
  readonly subjects = new Map<string, { type: string; id: string }>();

  async attach(input: Parameters<Files['attach']>[0]) {
    const known = this.subjects.get(input.fileId);
    if (known && (known.type !== input.subject.type || known.id !== input.subject.id)) {
      throw AppError.conflict('FILE_ALREADY_ATTACHED', 'Ce fichier est déjà rattaché à un autre objet.');
    }
    this.subjects.set(input.fileId, input.subject);
    return { fileId: input.fileId, contentType: 'application/pdf', sizeBytes: 1024 };
  }
}

export class MemoryDirectory implements Directory {
  readonly users = new Map<string, string>();
  readonly organizations = new Map<string, string>();

  async usersByIds(ids: readonly string[]): Promise<PersonSummary[]> {
    return ids
      .filter((id) => this.users.has(id))
      .map((id) => ({ userId: id, displayName: this.users.get(id)! }));
  }

  async organizationsByIds(ids: readonly string[]) {
    return ids
      .filter((id) => this.organizations.has(id))
      .map((id) => ({ organizationId: id, displayName: this.organizations.get(id)! }));
  }
}

/** Dépôts en mémoire des dossiers, branchés par `makeDeps`. */
export function memoryCaseStores() {
  const cases = new MemoryCaseRepository();
  return {
    cases,
    caseQueries: new MemoryCaseQueries(cases),
    imports: new MemoryCaseImportRepository(cases),
    preferences: new MemoryCreditorPreferences(),
    creditorProfiles: new MemoryCreditorProfiles(),
    spreadsheets: new MemorySpreadsheets(),
  };
}
