import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../../prisma/generated';
import {
  type CaseListFilter,
  type CaseQueries,
  type CaseSummaryRecord,
  type CreditorDashboardFigures,
  type EvidenceEntryData,
  type OverviewFigures,
  type PageRequest,
  type StaffScope,
  type StageTransitionData,
} from '../../application/cases/ports';
import { type Holder, type PersonalData } from '../../application/ports';
import { type CaseStage } from '../../domain/case';
import { PrismaService } from '../prisma/prisma.service';
import { CASE_PERSONAL_DATA } from './prisma-cases.repository';
import {
  evidenceOf,
  fromDateColumn,
  mainDebtorName,
  SUMMARY_INCLUDE,
  summaryOfRow,
  toDateColumn,
  transitionOf,
} from './prisma-case-rows';

/** Dossiers envoyés à KSP (montant confié) : en examen, en complément, actifs, suspendus, clos. */
const SUBMITTED = ['under_review', 'info_requested', 'active', 'suspended', 'closed'];
/** Dossiers en cours (montant restant, travail de l'équipe). */
const IN_PROGRESS = ['under_review', 'info_requested', 'active', 'suspended'];
const ACTIVE = ['active', 'suspended'];

/** Curseur d'une page du journal : date et identifiant de la dernière entrée lue. */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  return id && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
}

const toNumber = (value: unknown) => Number(value ?? 0);

/**
 * Lectures des dossiers (listes, journal, tableaux de bord). Les sommes sont calculées par la base ;
 * seuls les noms des débiteurs affichés sont déchiffrés, ligne par ligne.
 */
@Injectable()
export class PrismaCaseQueries implements CaseQueries {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CASE_PERSONAL_DATA) private readonly personal: PersonalData,
  ) {}

  private where(filter: CaseListFilter): Prisma.RecoveryCaseWhereInput {
    return {
      ...(filter.creditor ? { creditorType: filter.creditor.type, creditorId: filter.creditor.id } : {}),
      ...(filter.statuses ? { status: { in: [...filter.statuses] } } : {}),
      ...(filter.stages ? { stage: { in: [...filter.stages] } } : {}),
      ...(filter.kinds ? { kind: { in: [...filter.kinds] } } : {}),
      ...(filter.assignedAgentId ? { assignedAgentId: filter.assignedAgentId } : {}),
      ...(filter.creditorId ? { creditorId: filter.creditorId } : {}),
      ...(filter.communeKey ? { communeKey: filter.communeKey } : {}),
      ...(filter.number ? { number: { contains: filter.number } } : {}),
      ...(filter.partnerId
        ? { assignments: { some: { partnerId: filter.partnerId, status: 'active' } } }
        : {}),
      ...(filter.debtorNameTokens
        ? {
            debtors: {
              some: {
                nameTokens: {
                  hasEvery: filter.debtorNameTokens.map((token) => this.personal.nameIndex(token)),
                },
              },
            },
          }
        : {}),
      ...(filter.idleSince ? { lastActionAt: { lte: filter.idleSince } } : {}),
      ...(filter.prescriptionBefore
        ? { prescriptionDate: { lte: toDateColumn(filter.prescriptionBefore)! } }
        : {}),
    };
  }

  async list(
    filter: CaseListFilter,
    page: PageRequest,
  ): Promise<{ items: CaseSummaryRecord[]; nextCursor: string | null; total: number }> {
    const where = this.where(filter);
    const cursor = page.cursor && /^\d+$/.test(page.cursor) ? Number(page.cursor) : null;
    const [rows, total] = await Promise.all([
      this.prisma.recoveryCase.findMany({
        where: { ...where, ...(cursor !== null ? { sequence: { lt: cursor } } : {}) },
        include: SUMMARY_INCLUDE,
        orderBy: { sequence: 'desc' },
        take: page.limit + 1,
      }),
      this.prisma.recoveryCase.count({ where }),
    ]);
    const items = rows.slice(0, page.limit);
    return {
      items: items.map((row) => summaryOfRow(row, this.personal)),
      nextCursor: rows.length > page.limit ? String(items[items.length - 1]!.sequence) : null,
      total,
    };
  }

  async journal(
    caseId: string,
    options: { includeInternal: boolean },
    page: PageRequest,
  ): Promise<{ items: EvidenceEntryData[]; nextCursor: string | null }> {
    const after = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.prisma.evidenceEntry.findMany({
      where: {
        caseId,
        ...(options.includeInternal ? {} : { internal: false }),
        ...(after
          ? { OR: [{ occurredAt: { lt: after.at } }, { occurredAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: page.limit + 1,
    });
    const items = rows.slice(0, page.limit).map(evidenceOf);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > page.limit && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }

  async stageHistory(caseId: string): Promise<StageTransitionData[]> {
    const rows = await this.prisma.stageTransition.findMany({
      where: { caseId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    return rows.map(transitionOf);
  }

  /** Condition SQL du titulaire, ou du périmètre d'un membre du personnel. */
  private holderSql(holder: Holder) {
    return Prisma.sql`c.creditor_type = ${holder.type}::"PartyType" AND c.creditor_id = ${holder.id}::uuid`;
  }

  private scopeSql(scope: StaffScope) {
    const parts = [Prisma.sql`TRUE`];
    if (scope.agentId) parts.push(Prisma.sql`c.assigned_agent_id = ${scope.agentId}::uuid`);
    if (scope.communeKey) parts.push(Prisma.sql`c.commune_key = ${scope.communeKey}`);
    return Prisma.join(parts, ' AND ');
  }

  /** Montant confié, recouvré (hors trop-perçu) et restant dû des dossiers retenus. */
  private async amounts(condition: Prisma.Sql) {
    const [row] = await this.prisma.$queryRaw<
      { entrusted: unknown; recovered: unknown; outstanding: unknown }[]
    >`
      SELECT
        COALESCE(SUM(c.principal + c.interests + c.costs - COALESCE(p.prior, 0))
          FILTER (WHERE c.status::text = ANY(${SUBMITTED})), 0) AS entrusted,
        COALESCE(SUM(COALESCE(k.collected, 0)) FILTER (WHERE c.status::text = ANY(${SUBMITTED})), 0) AS recovered,
        COALESCE(SUM(GREATEST(0, c.principal + c.interests + c.costs - c.paid))
          FILTER (WHERE c.status::text = ANY(${IN_PROGRESS})), 0) AS outstanding
      FROM recovery_cases c
      LEFT JOIN (SELECT case_id, SUM(paid_before) AS prior FROM claims GROUP BY case_id) p ON p.case_id = c.id
      LEFT JOIN (SELECT case_id, SUM(gross - overpaid) AS collected FROM collections GROUP BY case_id) k
        ON k.case_id = c.id
      WHERE ${condition}`;
    return {
      entrusted: toNumber(row?.entrusted),
      recovered: toNumber(row?.recovered),
      outstanding: toNumber(row?.outstanding),
    };
  }

  private async stageCounts(condition: Prisma.Sql) {
    const rows = await this.prisma.$queryRaw<{ stage: string; count: unknown }[]>`
      SELECT c.stage::text AS stage, COUNT(*) AS count FROM recovery_cases c
      WHERE ${condition} AND c.status::text = ANY(${ACTIVE}) AND c.stage IS NOT NULL
      GROUP BY c.stage ORDER BY c.stage`;
    return rows.map((row) => ({ stage: row.stage, count: toNumber(row.count) }));
  }

  async creditorDashboard(creditor: Holder, today: string): Promise<CreditorDashboardFigures> {
    const condition = this.holderSql(creditor);
    const [amounts, stages, decisions, installments] = await Promise.all([
      this.amounts(condition),
      this.stageCounts(condition),
      this.prisma.$queryRaw<{ count: unknown }[]>`
        SELECT COUNT(*) AS count FROM decisions d JOIN recovery_cases c ON c.id = d.case_id
        WHERE ${condition} AND d.status = 'pending'`,
      this.prisma.$queryRaw<
        { case_id: string; number: string; due_date: Date; amount: number; paid: number }[]
      >`
        SELECT c.id AS case_id, c.number, i.due_date, i.amount, i.paid FROM installments i
        JOIN payment_plans p ON p.id = i.plan_id JOIN recovery_cases c ON c.id = p.case_id
        WHERE ${condition} AND p.status = 'signed' AND i.status IN ('upcoming', 'due', 'partial')
          AND i.due_date >= ${toDateColumn(today)}::date
        ORDER BY i.due_date, c.number LIMIT 10`,
    ]);
    const caseIds = [...new Set(installments.map((row) => row.case_id))];
    const debtors =
      caseIds.length > 0
        ? await this.prisma.debtor.findMany({ where: { caseId: { in: caseIds }, position: 0 } })
        : [];
    const names = new Map(debtors.map((debtor) => [debtor.caseId, mainDebtorName([debtor], this.personal)]));
    return {
      ...amounts,
      casesByStage: stages.map((row) => ({ stage: row.stage as CaseStage, count: row.count })),
      pendingDecisions: toNumber(decisions[0]?.count),
      upcomingInstallments: installments.map((row) => ({
        caseId: row.case_id,
        caseNumber: row.number,
        debtorName: names.get(row.case_id) ?? '',
        dueDate: fromDateColumn(row.due_date)!,
        amount: row.amount - row.paid,
      })),
    };
  }

  async overview(
    scope: StaffScope,
    today: string,
    options: { idleSince: Date; prescriptionBefore: string },
  ): Promise<OverviewFigures> {
    const condition = this.scopeSql(scope);
    const day = toDateColumn(today);
    const [amounts, stages, kinds, groups, agents, counters] = await Promise.all([
      this.amounts(condition),
      this.stageCounts(condition),
      this.prisma.$queryRaw<{ kind: string; count: unknown }[]>`
        SELECT c.kind::text AS kind, COUNT(*) AS count FROM recovery_cases c
        WHERE ${condition} AND c.status::text = ANY(${IN_PROGRESS}) GROUP BY c.kind ORDER BY c.kind`,
      this.prisma.$queryRaw<{ stage_group: string; amount: unknown }[]>`
        SELECT k.stage_group, SUM(k.gross - k.overpaid) AS amount FROM collections k
        JOIN recovery_cases c ON c.id = k.case_id WHERE ${condition}
        GROUP BY k.stage_group ORDER BY k.stage_group`,
      this.prisma.$queryRaw<
        { agent_id: string; open_cases: unknown; entrusted: unknown; recovered: unknown }[]
      >`
        SELECT c.assigned_agent_id::text AS agent_id,
          COUNT(*) FILTER (WHERE c.status::text = ANY(${IN_PROGRESS})) AS open_cases,
          COALESCE(SUM(c.principal + c.interests + c.costs - COALESCE(p.prior, 0)), 0) AS entrusted,
          COALESCE(SUM(COALESCE(k.collected, 0)), 0) AS recovered
        FROM recovery_cases c
        LEFT JOIN (SELECT case_id, SUM(paid_before) AS prior FROM claims GROUP BY case_id) p ON p.case_id = c.id
        LEFT JOIN (SELECT case_id, SUM(gross - overpaid) AS collected FROM collections GROUP BY case_id) k
          ON k.case_id = c.id
        WHERE ${condition} AND c.assigned_agent_id IS NOT NULL AND c.status::text = ANY(${SUBMITTED})
        GROUP BY c.assigned_agent_id ORDER BY c.assigned_agent_id`,
      this.prisma.$queryRaw<
        {
          installments_due: unknown;
          promises: unknown;
          idle: unknown;
          prescriptions: unknown;
          review: unknown;
          offline: unknown;
        }[]
      >`
        SELECT
          (SELECT COUNT(*) FROM installments i JOIN payment_plans p ON p.id = i.plan_id
            JOIN recovery_cases c ON c.id = p.case_id
            WHERE ${condition} AND p.status = 'signed' AND i.status IN ('upcoming', 'due') AND i.due_date = ${day}::date)
            AS installments_due,
          (SELECT COUNT(*) FROM payment_promises m JOIN recovery_cases c ON c.id = m.case_id
            WHERE ${condition} AND m.status = 'pending' AND m.due_date < ${day}::date) AS promises,
          (SELECT COUNT(*) FROM recovery_cases c WHERE ${condition} AND c.status::text = ANY(${ACTIVE})
            AND c.last_action_at <= ${options.idleSince}) AS idle,
          (SELECT COUNT(*) FROM recovery_cases c WHERE ${condition} AND c.status::text = ANY(${ACTIVE})
            AND c.prescription_date <= ${toDateColumn(options.prescriptionBefore)}::date) AS prescriptions,
          (SELECT COUNT(*) FROM recovery_cases c WHERE ${condition} AND c.status = 'under_review') AS review,
          (SELECT COUNT(*) FROM offline_payments o JOIN recovery_cases c ON c.id = o.case_id
            WHERE ${condition} AND o.status = 'pending') AS offline`,
    ]);
    const counter = counters[0];
    return {
      casesByStage: stages,
      casesByKind: kinds.map((row) => ({ stage: row.kind, count: toNumber(row.count) })),
      entrusted: amounts.entrusted,
      recovered: amounts.recovered,
      recoveredByStageGroup: groups.map((row) => ({ stage: row.stage_group, amount: toNumber(row.amount) })),
      agents: agents.map((row) => ({
        agentId: row.agent_id,
        openCases: toNumber(row.open_cases),
        entrusted: toNumber(row.entrusted),
        recovered: toNumber(row.recovered),
      })),
      installmentsDueToday: toNumber(counter?.installments_due),
      promisesToCheck: toNumber(counter?.promises),
      idleCases: toNumber(counter?.idle),
      prescriptionsNear: toNumber(counter?.prescriptions),
      reviewQueue: toNumber(counter?.review),
      offlinePaymentsToApprove: toNumber(counter?.offline),
    };
  }
}
