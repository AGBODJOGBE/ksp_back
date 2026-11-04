import { AppError } from '@ksp/platform';
import { type Mission } from '../../domain/mission';
import { findProposedSlot } from '../../domain/quote';
import { type QuoteRequest } from '../../domain/quote-request';
import { selectAcceptable } from '../../domain/request-group';
import { respectsLeadTime } from '../../domain/schedule';
import { type PriceLine } from '../../domain/simulator';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, type GroupOutcome, type OutboxMessage } from '../ports';
import {
  parseProposedSlots,
  type PreparedQuote,
  prepareQuote,
  quoteSentChanges,
} from '../requests/admin-requests.use-cases';
import { bookingChanges, newMission, paymentPlanFor } from '../requests/customer-requests.use-cases';
import { currentCustomer, requireStaff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import { parseDate, requireUuid } from '../shared/validation';
import {
  anyGroup,
  emptyOutcome,
  operationRecord,
  ownGroup,
  parseKey,
  previousOutcome,
  settle,
} from './group-support';

export interface GroupQuoteItemInput {
  requestId: string;
  lines: PriceLine[];
  recurrence?: { period: string; visitsPerPeriod: number; durationMonths: number } | undefined;
  teamSize: number;
  durationMinutes: number;
}

/** Erreur d'un devis du groupe : la demande en cause est ajoutée aux détails. */
function forRequest(error: unknown, requestId: string): unknown {
  if (!(error instanceof AppError)) return error;
  return new AppError(error.kind, error.code, error.message, { ...error.details, requestId });
}

/**
 * Devis du groupe envoyés ensemble (ADR-035) : un devis par demande, chiffré séparément (lignes
 * préremplies par demande si vides), avec les mêmes créneaux proposés ; tout ou rien. Chaque devis
 * publie son cleaning.quote.sent, comme un devis seul.
 */
export class SendGroupQuotesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    groupId: string;
    proposedSlots: { start: string; end: string }[];
    validityDays: number;
    quotes: GroupQuoteItemInput[];
    idempotencyKey?: string;
  }): Promise<GroupOutcome> {
    const staff = requireStaff(SUPERVISION);
    const key = parseKey(input.idempotencyKey, false);
    const view = await anyGroup(this.deps, input.groupId);
    const replay = await previousOutcome(this.deps, staff.userId, 'quotes.sent', key, view.group.id);
    if (replay) return replay;
    if (!input.quotes.length || input.quotes.length > view.requests.length) {
      throw CleaningErrors.invalid('quotes', 'Un devis par demande du groupe, au moins un.');
    }
    const now = this.deps.clock.now();
    const settings = await this.deps.catalog.getSettings();
    const proposedSlots = parseProposedSlots(input.proposedSlots, settings, now);
    const seen = new Set<string>();
    const prepared: PreparedQuote[] = [];
    for (const [index, item] of input.quotes.entries()) {
      const requestId = requireUuid(`quotes[${index}].requestId`, item.requestId);
      const request = view.requests.find((candidate) => candidate.id === requestId);
      if (!request) throw CleaningErrors.requestNotFound();
      if (seen.has(requestId))
        throw CleaningErrors.invalid(`quotes[${index}].requestId`, 'Demande en double.');
      seen.add(requestId);
      try {
        prepared.push(
          await prepareQuote(
            this.deps,
            request,
            { ...item, validityDays: input.validityDays },
            proposedSlots,
            settings,
            now,
          ),
        );
      } catch (error) {
        throw forRequest(error, requestId);
      }
    }
    const events: OutboxMessage[] = [];
    const audit: AuditEntry[] = [];
    for (const quote of prepared) {
      const changes = await quoteSentChanges(this.deps, staff.userId, quote, now, { groupId: view.group.id });
      events.push(...changes.events);
      audit.push(...changes.audit);
    }
    const outcome: GroupOutcome = {
      ...emptyOutcome(view.group.id),
      affectedIds: prepared.map((quote) => quote.request.id),
    };
    audit.push({
      actorId: staff.userId,
      action: 'request_group.quotes_sent',
      entityType: 'request_group',
      entityId: view.group.id,
      at: now,
      details: { requestIds: outcome.affectedIds, quoteIds: prepared.map((quote) => quote.quote.id) },
    });
    const written = await this.deps.requests.saveGroup({
      requests: prepared.map((quote) => ({ ...quote.request, updatedAt: now })),
      changes: { events, audit },
      operation: operationRecord(staff.userId, 'quotes.sent', key, outcome),
    });
    return settle(
      this.deps,
      written,
      { actorId: staff.userId, operation: 'quotes.sent', key, groupId: view.group.id },
      outcome,
    );
  }
}

/**
 * Acceptation commune (ADR-035) : un créneau et un plan de paiement communs, appliqués à chaque
 * devis envoyé du groupe qui propose ce créneau ; une mission par devis, dans une transaction. Les
 * autres demandes sont ignorées (l'acceptation par demande reste possible).
 */
export class AcceptGroupQuotesUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: {
    groupId: string;
    slotStart: string;
    paymentPlan?: { option: string; timing: string; method: string } | undefined;
    idempotencyKey: string;
  }): Promise<GroupOutcome> {
    const customer = currentCustomer();
    const key = parseKey(input.idempotencyKey, true);
    const view = await ownGroup(this.deps, customer.userId, input.groupId);
    const replay = await previousOutcome(this.deps, customer.userId, 'quotes.accepted', key, view.group.id);
    if (replay) return replay;
    const now = this.deps.clock.now();
    const slotStart = parseDate('slotStart', input.slotStart);
    const { selected, skipped } = selectAcceptable(view.requests, slotStart, now);
    if (!selected.length) throw CleaningErrors.groupNothingEligible(skipped);
    const settings = await this.deps.catalog.getSettings();
    if (!respectsLeadTime(slotStart, now, settings.minimumLeadHours)) {
      throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
    }
    const plan = paymentPlanFor(selected[0]!, input.paymentPlan);

    const events: OutboxMessage[] = [];
    const audit: AuditEntry[] = [];
    const accepted: QuoteRequest[] = [];
    const missions: Mission[] = [];
    for (const request of selected) {
      const quote = request.quote!;
      const mission = newMission(this.deps, request, quote, findProposedSlot(quote, slotStart)!, plan, now);
      missions.push(mission);
      accepted.push({ ...request, status: 'accepted', missionId: mission.id, updatedAt: now });
      const changes = await bookingChanges(this.deps, customer.userId, request, quote, mission, now, {
        groupId: view.group.id,
      });
      events.push(...changes.events);
      audit.push(...changes.audit);
    }
    const outcome: GroupOutcome = {
      ...emptyOutcome(view.group.id),
      affectedIds: accepted.map((request) => request.id),
      skippedRequests: skipped,
      missionIds: missions.map((mission) => mission.id),
    };
    audit.push({
      actorId: customer.userId,
      action: 'request_group.quotes_accepted',
      entityType: 'request_group',
      entityId: view.group.id,
      at: now,
      details: { requestIds: outcome.affectedIds, missionIds: outcome.missionIds, payment: plan },
    });
    const written = await this.deps.requests.saveGroup({
      requests: accepted,
      newMissions: missions.map((mission) => ({ mission, acceptanceKey: key })),
      changes: { events, audit },
      operation: operationRecord(customer.userId, 'quotes.accepted', key, outcome),
      // L'acceptation se fait au nom de l'organisation de la demande (ADR-030).
      organizationId: selected[0]!.organizationId,
    });
    return settle(
      this.deps,
      written,
      { actorId: customer.userId, operation: 'quotes.accepted', key, groupId: view.group.id },
      outcome,
    );
  }
}
