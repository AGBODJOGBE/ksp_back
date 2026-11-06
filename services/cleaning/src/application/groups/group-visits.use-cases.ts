import { groupVisitMembers, planGroupVisit } from '../../domain/request-group';
import { type QuoteRequest, type SiteVisit, type VisitStatus } from '../../domain/quote-request';
import { isBeforeScheduledTime } from '../../domain/schedule';
import { type CleaningDeps, presentRequest } from '../deps';
import { type AuditEntry, type GroupOutcome, type VisitEntry, type VisitFilter } from '../ports';
import { eventSubject } from '../shared/event-subject';
import { FIELD_WORK, requireStaff, seesEverything, type Staff, SUPERVISION } from '../shared/access';
import { measure, type MeasurementInput } from '../requests/measurements.use-cases';
import { CleaningErrors } from '../shared/errors';
import {
  oneOf,
  type PageRequest,
  type PageResult,
  parseDate,
  requiredText,
  requireUuid,
} from '../shared/validation';
import {
  anyGroup,
  emptyOutcome,
  operationRecord,
  parseKey,
  previousOutcome,
  requestForStaff,
  settle,
  type StaffRequest,
} from './group-support';

/**
 * Visite technique commune aux demandes d'un groupe (ADR-035) : même heure, même agent, un seul
 * événement cleaning.visit.scheduled (groupVisitId, requestIds). Une demande exclue qui faisait
 * partie de la visite commune en est détachée et garde sa visite, qui devient la sienne.
 */
export class ScheduleGroupVisitUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    groupId: string;
    scheduledAt: string;
    agentId: string;
    excludeRequestIds?: string[];
    idempotencyKey?: string;
  }): Promise<GroupOutcome> {
    const staff = requireStaff(SUPERVISION);
    const key = parseKey(input.idempotencyKey, false);
    const view = await anyGroup(this.deps, input.groupId);
    const replay = await previousOutcome(this.deps, staff.userId, 'visit.scheduled', key, view.group.id);
    if (replay) return replay;
    const now = this.deps.clock.now();
    const scheduledAt = parseDate('scheduledAt', input.scheduledAt);
    if (scheduledAt <= now) throw CleaningErrors.slotInvalid('La visite doit être planifiée dans le futur.');
    const agentId = requireUuid('agentId', input.agentId);
    const [agent] = await this.deps.agents.findAgents([agentId]);
    if (!agent?.active) throw CleaningErrors.agentNotFound([agentId]);
    const excluded = new Set(
      (input.excludeRequestIds ?? []).map((id, index) => requireUuid(`excludeRequestIds[${index}]`, id)),
    );

    const plan = planGroupVisit(view.requests, excluded, now);
    if (!plan.selected.length) throw CleaningErrors.groupNothingEligible(plan.skipped);
    const current = plan.selected.find((request) => request.visit?.status === 'scheduled')?.visit;
    const groupVisitId = current?.groupVisitId ?? this.deps.ids.next();
    const audit: AuditEntry[] = [];
    const scheduled = plan.selected.map((request): QuoteRequest => {
      const visit: SiteVisit = {
        id: request.visit?.status === 'scheduled' ? request.visit.id : this.deps.ids.next(),
        status: 'scheduled',
        scheduledAt,
        agentId,
        report: null,
        completedAt: null,
        groupVisitId,
      };
      audit.push({
        actorId: staff.userId,
        action: 'visit.scheduled',
        entityType: 'quote_request',
        entityId: request.id,
        at: now,
        details: { visitId: visit.id, agentId, groupVisitId },
      });
      return { ...request, status: 'visit_scheduled', visit, updatedAt: now };
    });
    const detached = plan.detached.map((request): QuoteRequest => {
      audit.push({
        actorId: staff.userId,
        action: 'visit.detached',
        entityType: 'quote_request',
        entityId: request.id,
        at: now,
        details: { visitId: request.visit!.id, detachedFrom: groupVisitId },
      });
      return { ...request, visit: { ...request.visit!, groupVisitId: null }, updatedAt: now };
    });
    const outcome: GroupOutcome = {
      ...emptyOutcome(view.group.id),
      affectedIds: scheduled.map((request) => request.id),
      skippedRequests: plan.skipped,
      groupVisitId,
    };
    audit.push({
      actorId: staff.userId,
      action: 'request_group.visit_scheduled',
      entityType: 'request_group',
      entityId: view.group.id,
      at: now,
      details: { groupVisitId, agentId, requestIds: outcome.affectedIds },
    });
    const lead = scheduled[0]!;
    // Une seule notification pour la visite commune : un événement, les demandes listées avec leur
    // prestation (ADR-035 point 14).
    const subjects = await Promise.all(scheduled.map((request) => eventSubject(this.deps, request)));
    const subject = subjects[0]!;
    const written = await this.deps.requests.saveGroup({
      requests: [...scheduled, ...detached],
      changes: {
        events: [
          {
            type: 'cleaning.visit.scheduled',
            payload: {
              ...subject,
              requestId: lead.id,
              visitId: lead.visit!.id,
              customerId: lead.customerId,
              agentId,
              scheduledAt: scheduledAt.toISOString(),
              groupVisitId,
              requestIds: outcome.affectedIds,
              requests: scheduled.map((request, index) => ({
                requestId: request.id,
                serviceCode: request.serviceCode,
                ...(subjects[index]!.serviceName ? { serviceName: subjects[index]!.serviceName } : {}),
              })),
            },
          },
        ],
        audit,
      },
      operation: operationRecord(staff.userId, 'visit.scheduled', key, outcome),
    });
    return settle(
      this.deps,
      written,
      { actorId: staff.userId, operation: 'visit.scheduled', key, groupId: view.group.id },
      outcome,
    );
  }
}

/**
 * Compte rendu commun de la visite de groupe (ADR-035) : toutes les visites encore planifiées de la
 * visite commune sont réalisées avec le même compte rendu. Ouvert à l'agent de cette visite.
 */
export class CompleteGroupVisitUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    groupId: string;
    report: string;
    idempotencyKey?: string;
    /** Mesures constatées par demande (ADR-037), facultatives : demandes de cette visite seulement. */
    measurements?: (MeasurementInput & { requestId: string })[] | undefined;
  }): Promise<GroupOutcome> {
    const staff = requireStaff(FIELD_WORK);
    const key = parseKey(input.idempotencyKey, false);
    const view = await anyGroup(this.deps, input.groupId);
    const replay = await previousOutcome(this.deps, staff.userId, 'visit.completed', key, view.group.id);
    if (replay) return replay;
    const members = groupVisitMembers(view.requests);
    const first = members[0]?.visit;
    if (!first || (!seesEverything(staff) && first.agentId !== staff.userId)) {
      throw CleaningErrors.visitNotFound();
    }
    const now = this.deps.clock.now();
    const { blockEarlyVisitReport, timeZone } = this.deps.fieldDates;
    if (blockEarlyVisitReport && isBeforeScheduledTime(now, first.scheduledAt)) {
      throw CleaningErrors.visitTooEarly(first.scheduledAt, timeZone);
    }
    const report = requiredText('report', input.report, 5000);
    const measured = await this.measurements(members, input.measurements ?? [], staff);
    const completed = members.map((request): QuoteRequest => ({
      ...(measured.get(request.id)?.request ?? request),
      visit: { ...request.visit!, status: 'completed', report, completedAt: now },
      updatedAt: now,
    }));
    const outcome: GroupOutcome = {
      ...emptyOutcome(view.group.id),
      affectedIds: completed.map((request) => request.id),
      groupVisitId: first.groupVisitId ?? null,
    };
    const written = await this.deps.requests.saveGroup({
      requests: completed,
      changes: {
        events: [],
        audit: completed.flatMap((request): AuditEntry[] => [
          {
            actorId: staff.userId,
            action: 'visit.completed',
            entityType: 'quote_request',
            entityId: request.id,
            at: now,
            details: { groupVisitId: outcome.groupVisitId },
          },
          ...(measured.has(request.id) ? [measured.get(request.id)!.audit] : []),
        ]),
      },
      operation: operationRecord(staff.userId, 'visit.completed', key, outcome),
    });
    return settle(
      this.deps,
      written,
      { actorId: staff.userId, operation: 'visit.completed', key, groupId: view.group.id },
      outcome,
    );
  }

  /**
   * Mesures de chaque demande de la visite commune, validées comme une simulation ; une demande
   * hors de cette visite, ou citée deux fois, est refusée (`measurements[i].requestId`).
   */
  private async measurements(
    members: QuoteRequest[],
    items: (MeasurementInput & { requestId: string })[],
    staff: Staff,
  ): Promise<Map<string, { request: QuoteRequest; audit: AuditEntry }>> {
    const measured = new Map<string, { request: QuoteRequest; audit: AuditEntry }>();
    for (const [index, item] of items.entries()) {
      const at = `measurements[${index}]`;
      const request = members.find((member) => member.id === item.requestId);
      if (!request || measured.has(request.id)) throw CleaningErrors.invalid(`${at}.requestId`);
      measured.set(request.id, await measure(this.deps, request, item, staff, 'visit', `${at}.`));
    }
    return measured;
  }
}

const VISIT_STATUSES: readonly VisitStatus[] = ['scheduled', 'completed', 'cancelled'];

export interface ListVisitsInput {
  page: PageRequest;
  agentId?: string;
  from?: string;
  to?: string;
  status?: string;
  groupId?: string;
}

/**
 * Visite présentée : chaque demande porte les réponses du client et ses mesures (ADR-037), pour
 * préremplir la saisie sur le terrain, sans montants pour un agent seul (`StaffRequest.withAmounts`).
 */
export interface VisitView extends VisitEntry {
  requests: StaffRequest[];
}

/**
 * Visites techniques (ADR-035) : la supervision voit tout (filtres agent, période, état, groupe),
 * un agent seulement les siennes ; une visite commune est une seule entrée. Pour un agent, la
 * position, le repère et l'adresse d'une visite terminée ou annulée sont masqués, et aucun montant
 * n'est donné (le recalcul EstimateRequestPrice lui reste ouvert).
 */
export class ListVisitsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: ListVisitsInput): Promise<PageResult<VisitView>> {
    const staff = requireStaff(FIELD_WORK);
    const filter: VisitFilter = {};
    if (!seesEverything(staff)) filter.agentId = staff.userId;
    else if (input.agentId) filter.agentId = requireUuid('agentId', input.agentId);
    if (input.from) filter.from = parseDate('from', input.from);
    if (input.to) filter.to = parseDate('to', input.to);
    if (input.status) filter.status = oneOf('status', input.status, VISIT_STATUSES);
    if (input.groupId) filter.groupId = requireUuid('groupId', input.groupId);
    const now = this.deps.clock.now();
    const page = await this.deps.requests.listVisits(filter, input.page);
    return {
      ...page,
      items: page.items.map((entry) => ({
        id: entry.id,
        requests: entry.requests.map((request) => requestForStaff(staff, presentRequest(request, now))),
      })),
    };
  }
}
