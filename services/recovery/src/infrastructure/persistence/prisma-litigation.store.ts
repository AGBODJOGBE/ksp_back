import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import { type DecisionRecord, type RowWrite } from '../../application/amicable/amicable.ports';
import { type PageRequest, type SaveOutcome } from '../../application/cases/ports';
import {
  type AssignmentListItem,
  type AssignmentRecord,
  type AssignmentStatus,
  type FeeQuoteRecord,
  type LegalActRecord,
  type LitigationCommit,
  type LitigationStore,
  type LitigationWrites,
  type NoticeKind,
  type NoticeRecord,
  type PartnerAudit,
  type PartnerFeeData,
  type PartnerFilter,
  type PartnerRecord,
  type PartnerStats,
  type ProvisionRecord,
} from '../../application/litigation/litigation.ports';
import { type PersonalData } from '../../application/ports';
import {
  type FeeLine,
  type LegalActType,
  type NoticeDeliveryMethod,
  type PaidStage,
} from '../../domain/litigation';
import { type PartnerKind, type PartnerStatus } from '../../domain/partner';
import { PrismaService } from '../prisma/prisma.service';
import { UuidV7Generator } from '../system/system';
import {
  caseColumns,
  evidenceOf,
  fromDateColumn,
  insertDocuments,
  isUniqueViolation,
  json,
  toDateColumn,
  type Tx,
  writeChanges,
} from './prisma-case-rows';
import { CASE_PERSONAL_DATA } from './prisma-cases.repository';

/** Version ou statut lu périmé (ou ligne déjà créée) : annule la transaction en cours. */
class StaleRow extends Error {}

function expectOne(result: { count: number }): void {
  if (result.count !== 1) throw new StaleRow();
}

/** Mises à jour d'abord (index partiels : une seule assignation active, une décision en attente). */
const updatesFirst = <T>(writes: readonly RowWrite<T>[]) =>
  [...writes].sort((a, b) => Number(a.expected === null) - Number(b.expected === null));

type PartnerRow = Prisma.PartnerGetPayload<object>;
type AssignmentRow = Prisma.PartnerAssignmentGetPayload<object>;
type ActRow = Prisma.LegalActGetPayload<object>;
type NoticeRow = Prisma.NoticeGetPayload<object>;
type QuoteRow = Prisma.FeeQuoteGetPayload<object>;
type ProvisionRow = Prisma.ProvisionGetPayload<object>;

/** Contexte du chiffrement des coordonnées professionnelles d'un partenaire (ADR-063). */
const partnerContactsContext = (partnerId: string) => `partners.contacts:${partnerId}`;
const REACHED_OUTCOMES = ['reached', 'promise', 'callback_requested'];
const OPEN_CASE_STATUSES = ['active', 'suspended'] as const;
const ENDED_CASE_STATUSES = ['closed', 'rejected'] as const;
const NO_UUID = '00000000-0000-0000-0000-000000000000';

function assignmentOf(row: AssignmentRow): AssignmentRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    partnerId: row.partnerId,
    status: row.status as AssignmentStatus,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt,
    note: row.note,
    quoteDocumentId: row.quoteDocumentId,
    lastUpdateAt: row.lastUpdateAt,
    withdrawnAt: row.withdrawnAt,
    withdrawReason: row.withdrawReason,
    completedAt: row.completedAt,
  };
}

function actOf(row: ActRow): LegalActRecord {
  return {
    id: row.id,
    assignmentId: row.assignmentId,
    caseId: row.caseId,
    type: row.type as LegalActType,
    actDate: fromDateColumn(row.actDate)!,
    cost: row.cost,
    fileId: row.fileId,
    note: row.note,
    nextStepDate: fromDateColumn(row.nextStepDate),
    recordedBy: row.recordedBy,
    recordedAt: row.createdAt,
  };
}

function noticeOf(row: NoticeRow): NoticeRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    kind: row.kind as NoticeKind,
    documentId: row.documentId,
    documentNumber: row.documentNumber,
    signedBy: row.signedBy,
    issuedAt: row.issuedAt,
    deadlineDays: row.deadlineDays,
    deliveryMethod: row.deliveryMethod as NoticeDeliveryMethod | null,
    deliveredAt: row.deliveredAt,
    deliveredBy: row.deliveredBy,
    proofFileId: row.proofFileId,
    deadlineAt: row.deadlineAt,
  };
}

function quoteOf(row: QuoteRow): FeeQuoteRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    decisionId: row.decisionId,
    stage: row.stage as PaidStage,
    partnerId: row.partnerId,
    lines: row.lines as unknown as FeeLine[],
    total: row.total,
    provision: row.provision,
    documentId: row.documentId,
    documentNumber: row.documentNumber,
    validUntil: row.validUntil,
    status: row.status as FeeQuoteRecord['status'],
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  };
}

function provisionOf(row: ProvisionRow): ProvisionRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    feeQuoteId: row.feeQuoteId,
    decisionId: row.decisionId,
    amount: row.amount,
    consumed: row.consumedAmount,
    status: row.status as ProvisionRecord['status'],
    debitTransactionId: row.debitReference ?? '',
    paidAt: row.paidAt ?? row.createdAt,
  };
}

/**
 * Lignes du contentieux (lot R5) : courriers, devis, provisions, partenaires, assignations et actes.
 * Une action s'écrit dans une transaction avec le dossier (verrou optimiste du lot R2) ou sa dernière
 * action, les décisions du lot R4 qu'elle ouvre ou tranche, le journal de preuve, l'outbox et l'audit ;
 * chaque ligne modifiée l'est à l'état lu. Coordonnées des partenaires chiffrées (ADR-063).
 */
@Injectable()
export class PrismaLitigationStore implements LitigationStore {
  private readonly ids = new UuidV7Generator();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CASE_PERSONAL_DATA) private readonly personal: PersonalData,
  ) {}

  async commit(commit: LitigationCommit): Promise<SaveOutcome> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<SaveOutcome> => {
        const caseId = commit.record?.id ?? commit.touch?.caseId ?? '';
        if (commit.record) {
          expectOne(
            await tx.recoveryCase.updateMany({
              where: { id: commit.record.id, version: commit.record.version },
              data: { ...caseColumns(commit.record), version: { increment: 1 } },
            }),
          );
          await insertDocuments(tx, commit.record);
        } else if (commit.touch) {
          await tx.$executeRaw`
            UPDATE recovery_cases SET last_action_at = GREATEST(COALESCE(last_action_at, ${commit.touch.at}), ${commit.touch.at})
            WHERE id = ${commit.touch.caseId}::uuid`;
        }
        await writeChanges(tx, caseId, commit.changes, () => this.ids.next());
        await this.writeRows(tx, commit.litigation);
        return 'saved';
      });
    } catch (error) {
      if (error instanceof StaleRow || isUniqueViolation(error)) return 'stale';
      throw error;
    }
  }

  private async writeRows(tx: Tx, rows: LitigationWrites): Promise<void> {
    for (const { row, expected } of updatesFirst(rows.assignments)) {
      const columns = {
        status: row.status,
        note: row.note,
        quoteDocumentId: row.quoteDocumentId,
        lastUpdateAt: row.lastUpdateAt,
        withdrawnAt: row.withdrawnAt,
        withdrawReason: row.withdrawReason,
        completedAt: row.completedAt,
      };
      if (expected === null) {
        await tx.partnerAssignment.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            partnerId: row.partnerId,
            assignedBy: row.assignedBy,
            assignedAt: row.assignedAt,
            ...columns,
          },
        });
      } else {
        expectOne(
          await tx.partnerAssignment.updateMany({
            where: { id: row.id, status: String(expected) },
            data: columns,
          }),
        );
      }
    }
    if (rows.acts.length > 0) {
      await tx.legalAct.createMany({
        data: rows.acts.map((act) => ({
          id: act.id,
          assignmentId: act.assignmentId,
          caseId: act.caseId,
          type: act.type,
          actDate: toDateColumn(act.actDate)!,
          cost: act.cost,
          fileId: act.fileId,
          note: act.note,
          nextStepDate: toDateColumn(act.nextStepDate),
          recordedBy: act.recordedBy,
          createdAt: act.recordedAt,
        })),
      });
    }
    for (const { row, expected } of rows.notices) {
      const columns = {
        deadlineDays: row.deadlineDays,
        deadlineAt: row.deadlineAt,
        deliveryMethod: row.deliveryMethod,
        deliveredAt: row.deliveredAt,
        deliveredBy: row.deliveredBy,
        proofFileId: row.proofFileId,
      };
      if (expected === null) {
        await tx.notice.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            kind: row.kind,
            documentId: row.documentId,
            documentNumber: row.documentNumber,
            signedBy: row.signedBy,
            issuedAt: row.issuedAt,
            ...columns,
          },
        });
      } else {
        expectOne(
          await tx.notice.updateMany({
            where: { id: row.id, deliveredAt: expected === 'issued' ? null : { not: null } },
            data: columns,
          }),
        );
      }
    }
    for (const { row, expected } of rows.feeQuotes) {
      if (expected === null) {
        await tx.feeQuote.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            decisionId: row.decisionId,
            stage: row.stage,
            partnerId: row.partnerId,
            lines: json(row.lines),
            total: row.total,
            provision: row.provision,
            documentId: row.documentId,
            documentNumber: row.documentNumber,
            validUntil: row.validUntil,
            status: row.status,
            note: row.note,
            createdBy: row.createdBy,
            createdAt: row.createdAt,
            answeredAt: row.answeredAt,
          },
        });
      } else {
        expectOne(
          await tx.feeQuote.updateMany({
            where: { id: row.id, status: String(expected) },
            data: { status: row.status, answeredAt: row.answeredAt },
          }),
        );
      }
    }
    for (const { row, expected } of rows.provisions) {
      if (expected === null) {
        await tx.provision.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            decisionId: row.decisionId,
            feeQuoteId: row.feeQuoteId,
            amount: row.amount,
            status: row.status,
            debitReference: row.debitTransactionId,
            paidAt: row.paidAt,
            consumedAmount: row.consumed,
          },
        });
      } else {
        expectOne(
          await tx.provision.updateMany({
            where: { id: row.id, consumedAmount: Number(expected) },
            data: { consumedAmount: row.consumed, status: row.status },
          }),
        );
      }
    }
    for (const { row, expected } of updatesFirst<DecisionRecord>(rows.decisions)) {
      const columns = {
        status: row.status,
        payload: json(row.payload),
        decidedAt: row.decidedAt,
        decidedBy: row.decidedBy,
        answer: row.answer === null ? Prisma.DbNull : json(row.answer),
      };
      if (expected === null) {
        await tx.decision.create({
          data: {
            id: row.id,
            caseId: row.caseId,
            type: row.kind,
            requestedBy: row.requestedBy,
            requestedAt: row.requestedAt,
            expiresAt: row.expiresAt,
            ...columns,
          },
        });
      } else {
        expectOne(
          await tx.decision.updateMany({ where: { id: row.id, status: String(expected) }, data: columns }),
        );
      }
    }
    if (rows.partnerDocuments.length > 0) {
      await tx.caseDocument.updateMany({
        where: { id: { in: [...rows.partnerDocuments] } },
        data: { visibleToPartner: true },
      });
    }
  }

  async savePartner(
    partner: PartnerRecord,
    expectedUpdatedAt: Date | null,
    audit: PartnerAudit,
  ): Promise<SaveOutcome> {
    const columns = {
      kind: partner.kind,
      userId: partner.userId,
      displayName: partner.name,
      office: partner.office ?? '',
      areas: partner.areas,
      contactsEnc: this.personal.encrypt(
        JSON.stringify({ phones: partner.phones, email: partner.email }),
        partnerContactsContext(partner.id),
      ),
      feeSchedule: json(partner.fees),
      status: partner.status,
      statusReason: partner.statusReason,
      verificationFileId: partner.verificationFileId,
      verifiedAt: partner.verifiedAt,
      verifiedBy: partner.verifiedBy,
      updatedAt: partner.updatedAt,
    };
    try {
      return await this.prisma.$transaction(async (tx): Promise<SaveOutcome> => {
        if (expectedUpdatedAt === null) {
          await tx.partner.create({
            data: { id: partner.id, createdBy: partner.createdBy, createdAt: partner.createdAt, ...columns },
          });
        } else {
          const updated = await tx.partner.updateMany({
            where: { id: partner.id, updatedAt: expectedUpdatedAt },
            data: columns,
          });
          if (updated.count !== 1) return 'stale';
        }
        await tx.auditEntry.create({
          data: {
            id: this.ids.next(),
            actorId: audit.actorId,
            action: audit.action,
            entityType: 'recovery_partner',
            entityId: partner.id,
            at: audit.at,
            ...(audit.details ? { details: json(audit.details) } : {}),
          },
        });
        return 'saved';
      });
    } catch (error) {
      if (isUniqueViolation(error)) return 'duplicate';
      throw error;
    }
  }

  private partnerOf(row: PartnerRow): PartnerRecord {
    const contacts = row.contactsEnc
      ? (JSON.parse(this.personal.decrypt(row.contactsEnc, partnerContactsContext(row.id))) as {
          phones?: string[];
          email?: string | null;
        })
      : {};
    return {
      id: row.id,
      kind: row.kind as PartnerKind,
      name: row.displayName,
      office: row.office || null,
      areas: row.areas,
      phones: contacts.phones ?? [],
      email: contacts.email ?? null,
      userId: row.userId,
      fees: (row.feeSchedule ?? []) as unknown as PartnerFeeData[],
      status: row.status as PartnerStatus,
      statusReason: row.statusReason,
      verificationFileId: row.verificationFileId,
      verifiedBy: row.verifiedBy,
      verifiedAt: row.verifiedAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async partner(id: string) {
    const row = await this.prisma.partner.findUnique({ where: { id } });
    return row ? this.partnerOf(row) : null;
  }

  async partnerByUser(userId: string) {
    const row = await this.prisma.partner.findUnique({ where: { userId } });
    return row ? this.partnerOf(row) : null;
  }

  async partners(filter: PartnerFilter, page: PageRequest) {
    const rows = await this.prisma.partner.findMany({
      where: {
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.statuses.length > 0 ? { status: { in: [...filter.statuses] } } : {}),
        ...(filter.communeKey ? { areas: { has: filter.communeKey } } : {}),
        ...(page.cursor ? { id: { gt: page.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map((row) => this.partnerOf(row));
    return { items, nextCursor: rows.length > page.limit ? items[items.length - 1]!.id : null };
  }

  async activePartners(kind: PartnerKind) {
    const rows = await this.prisma.partner.findMany({
      where: { kind, status: 'active' },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => this.partnerOf(row));
  }

  async partnerStats(partnerIds: readonly string[]) {
    const stats = new Map<string, PartnerStats>();
    if (partnerIds.length === 0) return stats;
    const rows = await this.prisma.$queryRaw<
      { partner_id: string; open: number; closed: number; successful: number; average_days: number | null }[]
    >`
      SELECT a.partner_id,
        COUNT(*) FILTER (WHERE a.status = 'active')::int AS open,
        COUNT(*) FILTER (WHERE a.status = 'completed')::int AS closed,
        COUNT(*) FILTER (
          WHERE a.status = 'completed' AND c.closure_reason IN ('paid', 'settlement_executed')
        )::int AS successful,
        (AVG(EXTRACT(EPOCH FROM (a.completed_at - a.assigned_at)) / 86400)
          FILTER (WHERE a.status = 'completed' AND a.completed_at IS NOT NULL))::float8 AS average_days
      FROM partner_assignments a JOIN recovery_cases c ON c.id = a.case_id
      WHERE a.partner_id = ANY(${[...partnerIds]}::uuid[])
      GROUP BY a.partner_id`;
    for (const row of rows) {
      stats.set(row.partner_id, {
        openAssignments: row.open,
        closedAssignments: row.closed,
        successfulAssignments: row.successful,
        averageDays: row.average_days === null ? null : Math.round(row.average_days),
      });
    }
    return stats;
  }

  async assignment(id: string) {
    const row = await this.prisma.partnerAssignment.findUnique({ where: { id } });
    return row ? assignmentOf(row) : null;
  }

  async caseAssignments(caseId: string) {
    const rows = await this.prisma.partnerAssignment.findMany({
      where: { caseId },
      orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(assignmentOf);
  }

  async assignmentsOf(partnerId: string, statuses: readonly AssignmentStatus[], page: PageRequest) {
    const rows = await this.prisma.partnerAssignment.findMany({
      where: {
        partnerId,
        status: { in: [...statuses] },
        ...(page.cursor ? { id: { lt: page.cursor } } : {}),
      },
      include: { case: { select: { number: true } } },
      orderBy: { id: 'desc' },
      take: page.limit + 1,
    });
    const items: AssignmentListItem[] = rows
      .slice(0, page.limit)
      .map((row) => ({ ...assignmentOf(row), caseNumber: row.case.number }));
    return { items, nextCursor: rows.length > page.limit ? items[items.length - 1]!.id : null };
  }

  async acts(assignmentIds: readonly string[]) {
    if (assignmentIds.length === 0) return [];
    const rows = await this.prisma.legalAct.findMany({
      where: { assignmentId: { in: [...assignmentIds] } },
      orderBy: [{ actDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(actOf);
  }

  async act(id: string) {
    const row = await this.prisma.legalAct.findUnique({ where: { id } });
    return row ? actOf(row) : null;
  }

  async caseActs(caseId: string) {
    const rows = await this.prisma.legalAct.findMany({
      where: { caseId },
      orderBy: [{ actDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(actOf);
  }

  async notice(id: string) {
    const row = await this.prisma.notice.findUnique({ where: { id } });
    return row ? noticeOf(row) : null;
  }

  async notices(caseId: string, kind: NoticeKind) {
    const rows = await this.prisma.notice.findMany({
      where: { caseId, kind },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(noticeOf);
  }

  async feeQuote(id: string) {
    const row = await this.prisma.feeQuote.findUnique({ where: { id } });
    return row ? quoteOf(row) : null;
  }

  async feeQuotes(caseId: string) {
    const rows = await this.prisma.feeQuote.findMany({
      where: { caseId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(quoteOf);
  }

  async provisions(caseId: string) {
    const rows = await this.prisma.provision.findMany({
      where: { caseId },
      orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(provisionOf);
  }

  async evidenceLog(caseId: string) {
    const rows = await this.prisma.evidenceEntry.findMany({
      where: { caseId, internal: false },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(evidenceOf);
  }

  async lastReachedContactAt(caseId: string) {
    const row = await this.prisma.contact.findFirst({
      where: { caseId, outcome: { in: REACHED_OUTCOMES } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    return row?.occurredAt ?? null;
  }

  async expiredNotices(now: Date, afterCaseId: string | null, limit: number) {
    // Dernière mise en demeure remise de chaque dossier actif à cette étape, délai écoulé.
    const latest = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT latest.id FROM (
        SELECT DISTINCT ON (n.case_id) n.id, n.case_id, n.deadline_at
        FROM notices n JOIN recovery_cases c ON c.id = n.case_id
        WHERE n.kind = 'formal_notice' AND n.delivered_at IS NOT NULL
          AND c.status = 'active' AND c.stage = 'formal_notice'
          AND n.case_id > ${afterCaseId ?? NO_UUID}::uuid
        ORDER BY n.case_id, n.delivered_at DESC
      ) latest
      WHERE latest.deadline_at <= ${now}
      ORDER BY latest.case_id
      LIMIT ${limit}`;
    if (latest.length === 0) return [];
    const rows = await this.prisma.notice.findMany({
      where: { id: { in: latest.map((row) => row.id) } },
      orderBy: { caseId: 'asc' },
    });
    return rows.map(noticeOf);
  }

  async silentAssignments(before: Date, afterId: string | null, limit: number) {
    const rows = await this.prisma.partnerAssignment.findMany({
      where: {
        status: 'active',
        lastUpdateAt: { lte: before },
        case: { status: { in: [...OPEN_CASE_STATUSES] } },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(assignmentOf);
  }

  async assignmentsOfClosedCases(limit: number) {
    const rows = await this.prisma.partnerAssignment.findMany({
      where: { status: 'active', case: { status: { in: [...ENDED_CASE_STATUSES] } } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map(assignmentOf);
  }
}
