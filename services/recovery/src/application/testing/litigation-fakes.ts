import { type PartnerKind } from '../../domain/partner';
import { type RowWrite } from '../amicable/amicable.ports';
import { type PageRequest, type SaveOutcome } from '../cases/ports';
import {
  type AssignmentListItem,
  type AssignmentRecord,
  type AssignmentStatus,
  type FeeQuoteRecord,
  type LegalActRecord,
  type LitigationCommit,
  type LitigationStore,
  type NoticeKind,
  noticeStatus,
  type NoticeRecord,
  type PartnerAudit,
  type PartnerFilter,
  type PartnerRecord,
  type PartnerStats,
  type ProvisionRecord,
} from '../litigation/litigation.ports';
import { type MemoryAmicableStore } from './amicable-fakes';
import { type MemoryCaseRepository } from './case-fakes';

/** Doublure en mémoire du contentieux (lot R5), écrite avec le dossier du dépôt en mémoire du lot R2. */

const clone = <T>(value: T): T => structuredClone(value);
const REACHED = new Set(['reached', 'promise', 'callback_requested']);
const SUCCESS = new Set(['paid', 'settlement_executed']);

function matches(current: { status: string } | undefined, write: RowWrite<unknown>): boolean {
  if (write.expected === null) return current === undefined;
  return current !== undefined && current.status === write.expected;
}

function page<T extends { id: string }>(items: T[], request: PageRequest, descending = false) {
  const sorted = [...items].sort((a, b) =>
    descending ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id),
  );
  const after = request.cursor
    ? sorted.filter((item) => (descending ? item.id < request.cursor! : item.id > request.cursor!))
    : sorted;
  const slice = after.slice(0, request.limit);
  return { items: slice, nextCursor: after.length > request.limit ? slice[slice.length - 1]!.id : null };
}

export class MemoryLitigationStore implements LitigationStore {
  readonly partnerRows = new Map<string, PartnerRecord>();
  readonly assignmentRows = new Map<string, AssignmentRecord>();
  readonly actRows = new Map<string, LegalActRecord>();
  readonly noticeRows = new Map<string, NoticeRecord>();
  readonly quoteRows = new Map<string, FeeQuoteRecord>();
  readonly provisionRows = new Map<string, ProvisionRecord>();
  readonly partnerAudit: PartnerAudit[] = [];
  /** Écritures concurrentes simulées : les prochaines rendent `stale`. */
  staleCommits = 0;

  constructor(
    private readonly cases: MemoryCaseRepository,
    private readonly amicable: MemoryAmicableStore,
  ) {}

  async commit(commit: LitigationCommit): Promise<SaveOutcome> {
    if (this.staleCommits > 0) {
      this.staleCommits -= 1;
      return 'stale';
    }
    const { litigation } = commit;
    const activeAfter = new Map(this.assignmentRows);
    for (const { row } of litigation.assignments) activeAfter.set(row.id, row);
    const fresh =
      litigation.assignments.every((write) => matches(this.assignmentRows.get(write.row.id), write)) &&
      litigation.feeQuotes.every((write) => matches(this.quoteRows.get(write.row.id), write)) &&
      litigation.decisions.every((write) => matches(this.amicable.decisionRows.get(write.row.id), write)) &&
      litigation.notices.every((write) => {
        const current = this.noticeRows.get(write.row.id);
        return write.expected === null
          ? !current
          : current !== undefined && noticeStatus(current) === write.expected;
      }) &&
      litigation.provisions.every((write) => {
        const current = this.provisionRows.get(write.row.id);
        return write.expected === null
          ? !current &&
              ![...this.provisionRows.values()].some((other) => other.feeQuoteId === write.row.feeQuoteId)
          : current?.consumed === write.expected;
      }) &&
      litigation.acts.every((act) => !this.actRows.has(act.id)) &&
      litigation.assignments.every(
        ({ row }) =>
          row.status !== 'active' ||
          ![...activeAfter.values()].some(
            (other) => other.id !== row.id && other.caseId === row.caseId && other.status === 'active',
          ),
      ) &&
      litigation.decisions.every(
        ({ row }) =>
          row.status !== 'pending' ||
          ![...this.amicable.decisionRows.values()].some(
            (other) =>
              other.id !== row.id &&
              other.caseId === row.caseId &&
              other.kind === row.kind &&
              other.status === 'pending',
          ),
      );
    if (!fresh) return 'stale';
    if (commit.record) {
      const outcome = await this.cases.save(commit.record, commit.changes);
      if (outcome !== 'saved') return outcome;
    } else {
      this.cases.evidence.push(...clone(commit.changes.evidence));
      this.cases.events.push(...clone(commit.changes.events));
      this.cases.audit.push(...clone(commit.changes.audit));
      const stored = commit.touch ? this.cases.cases.get(commit.touch.caseId) : undefined;
      if (stored && commit.touch && (!stored.lastActionAt || stored.lastActionAt < commit.touch.at)) {
        stored.lastActionAt = commit.touch.at;
      }
    }
    for (const { row } of litigation.assignments) this.assignmentRows.set(row.id, clone(row));
    for (const act of litigation.acts) this.actRows.set(act.id, clone(act));
    for (const { row } of litigation.notices) this.noticeRows.set(row.id, clone(row));
    for (const { row } of litigation.feeQuotes) this.quoteRows.set(row.id, clone(row));
    for (const { row } of litigation.provisions) this.provisionRows.set(row.id, clone(row));
    for (const { row } of litigation.decisions) this.amicable.decisionRows.set(row.id, clone(row));
    for (const record of this.cases.cases.values()) {
      for (const document of record.documents) {
        if (litigation.partnerDocuments.includes(document.id)) document.visibleToPartner = true;
      }
    }
    return 'saved';
  }

  async savePartner(partner: PartnerRecord, expectedUpdatedAt: Date | null, audit: PartnerAudit) {
    const current = this.partnerRows.get(partner.id);
    if (expectedUpdatedAt === null ? current : current?.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      return expectedUpdatedAt === null ? ('duplicate' as const) : ('stale' as const);
    }
    if (
      partner.userId &&
      [...this.partnerRows.values()].some(
        (other) => other.id !== partner.id && other.userId === partner.userId,
      )
    ) {
      return 'duplicate' as const;
    }
    this.partnerRows.set(partner.id, clone(partner));
    this.partnerAudit.push(clone(audit));
    return 'saved' as const;
  }

  async partner(id: string) {
    return clone(this.partnerRows.get(id) ?? null);
  }
  async partnerByUser(userId: string) {
    return clone([...this.partnerRows.values()].find((partner) => partner.userId === userId) ?? null);
  }
  async partners(filter: PartnerFilter, request: PageRequest) {
    const items = [...this.partnerRows.values()].filter(
      (partner) =>
        (!filter.kind || partner.kind === filter.kind) &&
        (filter.statuses.length === 0 || filter.statuses.includes(partner.status)) &&
        (!filter.communeKey || partner.areas.includes(filter.communeKey)),
    );
    return clone(page(items, request));
  }
  async activePartners(kind: PartnerKind) {
    return clone([...this.partnerRows.values()].filter((p) => p.kind === kind && p.status === 'active'));
  }
  async partnerStats(partnerIds: readonly string[]) {
    const stats = new Map<string, PartnerStats>();
    for (const id of partnerIds) {
      const assignments = [...this.assignmentRows.values()].filter((a) => a.partnerId === id);
      const completed = assignments.filter((a) => a.status === 'completed' && a.completedAt);
      const days = completed.map((a) => (a.completedAt!.getTime() - a.assignedAt.getTime()) / 86_400_000);
      stats.set(id, {
        openAssignments: assignments.filter((a) => a.status === 'active').length,
        closedAssignments: completed.length,
        successfulAssignments: completed.filter((a) =>
          SUCCESS.has(this.cases.cases.get(a.caseId)?.closureReason ?? ''),
        ).length,
        averageDays: days.length ? Math.round(days.reduce((sum, d) => sum + d, 0) / days.length) : null,
      });
    }
    return stats;
  }

  async assignment(id: string) {
    return clone(this.assignmentRows.get(id) ?? null);
  }
  async caseAssignments(caseId: string) {
    return clone(
      [...this.assignmentRows.values()]
        .filter((a) => a.caseId === caseId)
        .sort((a, b) => a.assignedAt.getTime() - b.assignedAt.getTime()),
    );
  }
  async assignmentsOf(partnerId: string, statuses: readonly AssignmentStatus[], request: PageRequest) {
    const items: AssignmentListItem[] = [...this.assignmentRows.values()]
      .filter((a) => a.partnerId === partnerId && statuses.includes(a.status))
      .map((a) => ({ ...a, caseNumber: this.cases.cases.get(a.caseId)?.number ?? '' }));
    return clone(page(items, request, true));
  }
  async acts(assignmentIds: readonly string[]) {
    return clone(
      [...this.actRows.values()]
        .filter((act) => assignmentIds.includes(act.assignmentId))
        .sort(
          (a, b) => a.actDate.localeCompare(b.actDate) || a.recordedAt.getTime() - b.recordedAt.getTime(),
        ),
    );
  }
  async act(id: string) {
    return clone(this.actRows.get(id) ?? null);
  }
  async caseActs(caseId: string) {
    return clone([...this.actRows.values()].filter((act) => act.caseId === caseId));
  }

  async notice(id: string) {
    return clone(this.noticeRows.get(id) ?? null);
  }
  async notices(caseId: string, kind: NoticeKind) {
    return clone(
      [...this.noticeRows.values()]
        .filter((notice) => notice.caseId === caseId && notice.kind === kind)
        .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime()),
    );
  }
  async feeQuote(id: string) {
    return clone(this.quoteRows.get(id) ?? null);
  }
  async feeQuotes(caseId: string) {
    return clone(
      [...this.quoteRows.values()]
        .filter((quote) => quote.caseId === caseId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }
  async provisions(caseId: string) {
    return clone(
      [...this.provisionRows.values()]
        .filter((provision) => provision.caseId === caseId)
        .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()),
    );
  }

  async evidenceLog(caseId: string) {
    return clone(
      this.cases.evidence
        .filter((entry) => entry.caseId === caseId && !entry.internal)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
    );
  }
  async lastReachedContactAt(caseId: string) {
    const reached = [...this.amicable.contacts.values()]
      .filter((contact) => contact.caseId === caseId && REACHED.has(contact.outcome ?? ''))
      .map((contact) => contact.occurredAt.getTime());
    return reached.length ? new Date(Math.max(...reached)) : null;
  }

  async expiredNotices(now: Date, afterCaseId: string | null, limit: number) {
    const latest = new Map<string, NoticeRecord>();
    for (const notice of this.noticeRows.values()) {
      if (notice.kind !== 'formal_notice' || !notice.deliveredAt) continue;
      const known = latest.get(notice.caseId);
      if (!known || known.deliveredAt! < notice.deliveredAt) latest.set(notice.caseId, notice);
    }
    return clone(
      [...latest.values()]
        .filter((notice) => {
          const record = this.cases.cases.get(notice.caseId);
          return (
            record?.status === 'active' &&
            record.stage === 'formal_notice' &&
            notice.deadlineAt !== null &&
            notice.deadlineAt <= now &&
            (!afterCaseId || notice.caseId > afterCaseId)
          );
        })
        .sort((a, b) => a.caseId.localeCompare(b.caseId))
        .slice(0, limit),
    );
  }
  async silentAssignments(before: Date, afterId: string | null, limit: number) {
    return clone(
      [...this.assignmentRows.values()]
        .filter((a) => {
          const status = this.cases.cases.get(a.caseId)?.status;
          return (
            a.status === 'active' &&
            a.lastUpdateAt <= before &&
            (status === 'active' || status === 'suspended') &&
            (!afterId || a.id > afterId)
          );
        })
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, limit),
    );
  }
  async assignmentsOfClosedCases(limit: number) {
    return clone(
      [...this.assignmentRows.values()]
        .filter((a) => {
          const status = this.cases.cases.get(a.caseId)?.status;
          return a.status === 'active' && (status === 'closed' || status === 'rejected');
        })
        .slice(0, limit),
    );
  }
}
