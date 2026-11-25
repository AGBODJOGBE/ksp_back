import { localInstant } from '../../domain/calendar';
import { type CaseStage, type CaseStatus } from '../../domain/case';
import { type DecisionKind, type DecisionStatus } from '../../domain/decision';
import {
  type AmicableCommit,
  type AmicableFollowUp,
  type AmicableStore,
  type ContactRecord,
  type DebtorMessageRecord,
  type DecisionListItem,
  type DecisionRecord,
  type DocumentCancellation,
  type PlanRecord,
  type PromiseRecord,
  type RowWrite,
  type SettlementRecord,
  type WorkQueueRow,
} from '../amicable/amicable.ports';
import { type PageRequest, type SaveOutcome } from '../cases/ports';
import { DEBTOR_CONTACT_CONTEXT } from '../debtor-access/debtor-contact';
import { type CaseDebtor, type EncryptedContact } from '../debtor-access/debtor-access.ports';
import { type Holder, type PersonalData } from '../ports';
import { type MemoryCaseRepository, summaryOf } from './case-fakes';
import { MemoryDebtorCaseReader } from './debtor-access.fakes';

/** Doublures en mémoire de la procédure amiable (lot R4). */

const OPEN: ReadonlySet<CaseStatus> = new Set(['active', 'suspended']);
const clone = <T>(value: T): T => structuredClone(value);

/** Ligne attendue dans l'état lu : nouvelle (absente), ou au statut (ou à la version) lu. */
function matches(
  current: { status: string; version?: number } | undefined,
  write: RowWrite<unknown>,
): boolean {
  if (write.expected === null) return current === undefined;
  if (current === undefined) return false;
  return typeof write.expected === 'number'
    ? current.version === write.expected
    : current.status === write.expected;
}

/**
 * Lignes de la procédure, écrites avec le dossier du dépôt en mémoire du lot R2 : même verrou
 * optimiste, même journal, même outbox. Les encaissements (lot R3), les contestations et les
 * rappels demandés par le débiteur sont posés par les tests.
 */
export class MemoryAmicableStore implements AmicableStore {
  readonly contacts = new Map<string, ContactRecord>();
  readonly promiseRows = new Map<string, PromiseRecord>();
  readonly planRows = new Map<string, PlanRecord>();
  readonly decisionRows = new Map<string, DecisionRecord>();
  readonly settlementRows = new Map<string, SettlementRecord>();
  readonly messages = new Map<string, DebtorMessageRecord>();
  readonly collections: { caseId: string; gross: number; overpaid: number; collectedAt: Date }[] = [];
  readonly disputes: { caseId: string; openedAt: Date }[] = [];
  readonly callbackRequests: { caseId: string; slotStart: Date }[] = [];
  /** Écritures concurrentes simulées : les prochaines rendent `stale`. */
  staleCommits = 0;

  constructor(private readonly cases: MemoryCaseRepository) {}

  async commit(commit: AmicableCommit): Promise<SaveOutcome> {
    if (this.staleCommits > 0) {
      this.staleCommits -= 1;
      return 'stale';
    }
    const { amicable } = commit;
    const fresh =
      amicable.promises.every((write) => matches(this.promiseRows.get(write.row.id), write)) &&
      amicable.plans.every((write) => matches(this.planRows.get(write.row.id), write)) &&
      amicable.decisions.every((write) => matches(this.decisionRows.get(write.row.id), write)) &&
      amicable.settlements.every((write) => matches(this.settlementRows.get(write.row.id), write)) &&
      amicable.contacts.every((contact) => !this.contacts.has(contact.id)) &&
      amicable.decisions.every(
        (write) =>
          write.row.status !== 'pending' ||
          ![...this.decisionRows.values()].some(
            (other) =>
              other.id !== write.row.id &&
              other.caseId === write.row.caseId &&
              other.kind === write.row.kind &&
              other.status === 'pending',
          ),
      );
    if (!fresh) return 'stale';
    if (commit.record) {
      const outcome = await this.cases.save(
        commit.record,
        commit.changes,
        commit.inbox ? { inbox: commit.inbox } : {},
      );
      if (outcome !== 'saved') return outcome;
    } else {
      if (commit.inbox) {
        const key = `${commit.inbox.eventId}:${commit.inbox.consumer}`;
        if (this.cases.inbox.has(key)) return 'duplicate';
        this.cases.inbox.add(key);
      }
      this.cases.evidence.push(...clone(commit.changes.evidence));
      this.cases.events.push(...clone(commit.changes.events));
      this.cases.audit.push(...clone(commit.changes.audit));
      const stored = commit.touch ? this.cases.cases.get(commit.touch.caseId) : undefined;
      if (stored && commit.touch && (!stored.lastActionAt || stored.lastActionAt < commit.touch.at)) {
        stored.lastActionAt = commit.touch.at;
      }
    }
    for (const contact of amicable.contacts) this.contacts.set(contact.id, clone(contact));
    for (const done of amicable.callbacksDone) {
      for (const contact of this.contacts.values()) {
        if (
          contact.caseId === done.caseId &&
          contact.callbackAt &&
          !contact.callbackDoneAt &&
          contact.callbackAt < done.until
        ) {
          contact.callbackDoneAt = done.at;
        }
      }
    }
    for (const { row } of amicable.promises) this.promiseRows.set(row.id, clone(row));
    for (const { row, expected } of amicable.plans) {
      this.planRows.set(row.id, { ...clone(row), version: expected === null ? 0 : Number(expected) + 1 });
    }
    for (const { row } of amicable.decisions) this.decisionRows.set(row.id, clone(row));
    for (const { row } of amicable.settlements) this.settlementRows.set(row.id, clone(row));
    for (const message of amicable.messages) {
      if (![...this.messages.values()].some((other) => other.dedupeKey === message.dedupeKey)) {
        this.messages.set(message.id, clone(message));
      }
    }
    for (const message of amicable.messageUpdates) this.messages.set(message.id, clone(message));
    return 'saved';
  }

  async contact(id: string) {
    return clone(this.contacts.get(id) ?? null);
  }
  async promise(id: string) {
    return clone(this.promiseRows.get(id) ?? null);
  }
  async plan(id: string) {
    return clone(this.planRows.get(id) ?? null);
  }
  async planByDocument(documentId: string) {
    return clone([...this.planRows.values()].find((plan) => plan.documentId === documentId) ?? null);
  }
  async decision(id: string) {
    return clone(this.decisionRows.get(id) ?? null);
  }
  async settlement(id: string) {
    return clone(this.settlementRows.get(id) ?? null);
  }
  async evidence(id: string) {
    return clone(this.cases.evidence.find((entry) => entry.id === id) ?? null);
  }
  async message(dedupeKey: string) {
    return clone([...this.messages.values()].find((message) => message.dedupeKey === dedupeKey) ?? null);
  }
  async plans(caseId: string) {
    return clone(
      [...this.planRows.values()]
        .filter((plan) => plan.caseId === caseId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)),
    );
  }
  async promises(caseId: string) {
    return clone([...this.promiseRows.values()].filter((promise) => promise.caseId === caseId));
  }
  async settlements(caseId: string) {
    return clone([...this.settlementRows.values()].filter((settlement) => settlement.caseId === caseId));
  }
  async pendingDecision(caseId: string, kind: DecisionKind) {
    const found = [...this.decisionRows.values()].find(
      (decision) => decision.caseId === caseId && decision.kind === kind && decision.status === 'pending',
    );
    return clone(found ?? null);
  }
  async stageStart(caseId: string) {
    const last = this.cases.transitions.filter((transition) => transition.caseId === caseId).at(-1);
    return last ? { transitionId: last.id, stage: last.to, at: last.at } : null;
  }
  async hasEvidence(caseId: string, action: string, since: Date) {
    return this.cases.evidence.some(
      (entry) => entry.caseId === caseId && entry.action === action && entry.occurredAt >= since,
    );
  }
  async collectedSince(caseId: string, since: Date) {
    return this.collections
      .filter((row) => row.caseId === caseId && row.collectedAt >= since)
      .reduce((sum, row) => sum + row.gross - row.overpaid, 0);
  }

  async activeCases(stages: readonly CaseStage[], afterId: string | null, limit: number) {
    return [...this.cases.cases.values()]
      .filter(
        (record) => record.status === 'active' && record.stage !== null && stages.includes(record.stage),
      )
      .map((record) => record.id)
      .sort()
      .filter((id) => afterId === null || id > afterId)
      .slice(0, limit);
  }
  async casesWithoutNotice(limit: number) {
    const noticed = new Set(
      [...this.messages.values()]
        .filter((message) => message.purpose === 'notice')
        .map((message) => message.caseId),
    );
    return (await this.activeCases(['notice'], null, Number.MAX_SAFE_INTEGER))
      .filter((id) => !noticed.has(id))
      .slice(0, limit);
  }
  async signedPlans(afterId: string | null, limit: number) {
    return clone(
      [...this.planRows.values()]
        .filter((plan) => plan.status === 'signed' && (afterId === null || plan.id > afterId))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit),
    );
  }
  async pendingPromises(afterId: string | null, limit: number) {
    return [...this.promiseRows.values()]
      .filter((promise) => promise.status === 'pending' && (afterId === null || promise.id > afterId))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((promise) => ({
        promise: clone(promise),
        caseStatus: this.cases.cases.get(promise.caseId)!.status,
      }));
  }
  async expiredDecisions(now: Date, limit: number) {
    return clone(
      [...this.decisionRows.values()]
        .filter((decision) => decision.status === 'pending' && decision.expiresAt <= now)
        .slice(0, limit),
    );
  }
  async expiredSettlements(today: string, limit: number) {
    return clone(
      [...this.settlementRows.values()]
        .filter(
          (settlement) =>
            (settlement.status === 'proposed' || settlement.status === 'accepted') &&
            settlement.validUntil < today,
        )
        .slice(0, limit),
    );
  }
  async claimMessages(now: Date, leaseUntil: Date, limit: number) {
    const due = [...this.messages.values()]
      .filter((message) => message.status === 'pending' && message.notBefore <= now)
      .sort((a, b) => a.notBefore.getTime() - b.notBefore.getTime())
      .slice(0, limit);
    for (const message of due) {
      message.attempts += 1;
      message.notBefore = leaseUntil;
    }
    return clone(due);
  }

  /** Dossier ouvert dans le périmètre du chargé (tous si null). */
  private inScope(caseId: string, agentId: string | null): boolean {
    const record = this.cases.cases.get(caseId);
    return !!record && OPEN.has(record.status) && (agentId === null || record.assignedAgentId === agentId);
  }

  async workQueue(scope: { agentId: string | null; plansToValidate: boolean }, until: Date) {
    const rows: WorkQueueRow[] = [];
    const mine = (caseId: string) => this.inScope(caseId, scope.agentId);
    for (const contact of this.contacts.values()) {
      if (
        contact.callbackAt &&
        !contact.callbackDoneAt &&
        contact.callbackAt < until &&
        mine(contact.caseId)
      ) {
        rows.push({
          kind: 'promised_callback',
          caseId: contact.caseId,
          dueAt: contact.callbackAt,
          note: contact.note ?? '',
        });
      }
    }
    for (const promise of this.promiseRows.values()) {
      if (promise.status === 'broken' && promise.brokenAt && mine(promise.caseId)) {
        rows.push({
          kind: 'broken_promise',
          caseId: promise.caseId,
          dueAt: promise.brokenAt,
          note: promise.note ?? '',
        });
      }
    }
    for (const plan of this.planRows.values()) {
      if (plan.status === 'signed' && mine(plan.caseId)) {
        for (const installment of plan.installments.filter((i) => i.status === 'missed')) {
          rows.push({
            kind: 'missed_installment',
            caseId: plan.caseId,
            dueAt: localInstant(installment.dueDate, 0),
            note: `Échéance ${installment.rank}`,
          });
        }
      }
      if (
        plan.status === 'proposed' &&
        plan.documentId === null &&
        this.inScope(plan.caseId, scope.plansToValidate ? null : scope.agentId)
      ) {
        rows.push({
          kind: 'plan_to_validate',
          caseId: plan.caseId,
          dueAt: plan.createdAt,
          note: plan.note ?? '',
        });
      }
    }
    for (const request of this.callbackRequests) {
      if (request.slotStart < until && mine(request.caseId)) {
        rows.push({ kind: 'callback_request', caseId: request.caseId, dueAt: request.slotStart, note: '' });
      }
    }
    for (const dispute of this.disputes) {
      if (mine(dispute.caseId))
        rows.push({ kind: 'dispute', caseId: dispute.caseId, dueAt: dispute.openedAt, note: '' });
    }
    return rows;
  }

  async amicableFollowUps(agentId: string | null, limit: number) {
    const followUps: AmicableFollowUp[] = [];
    for (const record of this.cases.cases.values()) {
      if (record.status !== 'active' || record.stage !== 'amicable') continue;
      if (agentId !== null && record.assignedAgentId !== agentId) continue;
      const start = await this.stageStart(record.id);
      if (!start) continue;
      const prefix = `amicable:${start.transitionId}:`;
      followUps.push({
        caseId: record.id,
        transitionId: start.transitionId,
        startedAt: start.at,
        outboundContacts: [...this.contacts.values()]
          .filter((c) => c.caseId === record.id && c.direction === 'outbound' && c.occurredAt >= start.at)
          .map((c) => ({ channel: c.channel, occurredAt: c.occurredAt })),
        automaticSteps: [...this.messages.values()]
          .filter((message) => message.dedupeKey.startsWith(prefix))
          .map((message) => Number(message.dedupeKey.slice(prefix.length))),
      });
    }
    return followUps.slice(0, limit);
  }

  async summaries(caseIds: readonly string[]) {
    return caseIds
      .map((id) => this.cases.cases.get(id))
      .filter((record) => record !== undefined)
      .map((record) => summaryOf(record));
  }

  async decisionsOf(
    creditor: Holder,
    filter: { statuses: readonly DecisionStatus[]; caseId: string | null },
    page: PageRequest,
  ) {
    const items: DecisionListItem[] = [...this.decisionRows.values()]
      .filter((decision) => {
        const record = this.cases.cases.get(decision.caseId);
        return (
          record &&
          record.creditor.type === creditor.type &&
          record.creditor.id === creditor.id &&
          filter.statuses.includes(decision.status) &&
          (filter.caseId === null || decision.caseId === filter.caseId) &&
          (page.cursor === null || decision.id < page.cursor)
        );
      })
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((decision) => ({
        decision: clone(decision),
        caseNumber: this.cases.cases.get(decision.caseId)!.number,
      }));
    const pageItems = items.slice(0, page.limit);
    return {
      items: pageItems,
      nextCursor: items.length > page.limit ? pageItems[pageItems.length - 1]!.decision.id : null,
    };
  }
}

/** Annulations de documents demandées à document. */
export class MemoryDocumentCancellation implements DocumentCancellation {
  readonly cancelled: { documentId: string; reason: string }[] = [];
  async cancel(input: { documentId: string; reason: string }): Promise<void> {
    this.cancelled.push(input);
  }
}

/** Lecture du débiteur d'un dossier pour son lien (ADR-061), servie par le dépôt des dossiers en mémoire. */
export class CaseBackedDebtorReader extends MemoryDebtorCaseReader {
  constructor(
    private readonly repository: MemoryCaseRepository,
    private readonly personal: PersonalData,
  ) {
    super();
  }

  override async caseDebtor(caseId: string, debtorId: string): Promise<CaseDebtor | null> {
    const record = this.repository.cases.get(caseId);
    if (!record || !record.debtors.some((debtor) => debtor.id === debtorId)) return null;
    return { caseNumber: record.number, caseStatus: record.status, creditor: record.creditor };
  }

  override async contacts(debtorId: string): Promise<EncryptedContact[]> {
    const debtor = [...this.repository.cases.values()]
      .flatMap((record) => record.debtors)
      .find((candidate) => candidate.id === debtorId);
    return (debtor?.contacts ?? [])
      .filter((contact) => contact.valid)
      .map((contact) => ({
        channel: contact.channel,
        valueEnc: this.personal.encrypt(contact.value, DEBTOR_CONTACT_CONTEXT),
      }));
  }
}
