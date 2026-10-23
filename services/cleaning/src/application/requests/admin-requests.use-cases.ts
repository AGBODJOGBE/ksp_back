import { type ServiceDefinition } from '../../domain/catalog';
import {
  buildQuote,
  isValidLine,
  linesSubtotal,
  MAX_PROPOSED_SLOTS,
  MIN_PROPOSED_SLOTS,
} from '../../domain/quote';
import { isVisitRequired, type QuoteRequest, type RequestStatus } from '../../domain/quote-request';
import { respectsLeadTime } from '../../domain/schedule';
import { type PriceLine, priceLines, simulate } from '../../domain/simulator';
import { type CleaningDeps, presentRequest } from '../deps';
import { requireStaff, SUPERVISION } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import {
  type PageRequest,
  type PageResult,
  parseDate,
  parseRecurrence,
  parseSlot,
  requiredText,
  requirePositiveInt,
  requireUuid,
} from '../shared/validation';
import { assertRequestTransition, saveRequest } from './customer-requests.use-cases';

const REQUEST_STATUSES: readonly RequestStatus[] = [
  'received',
  'visit_scheduled',
  'quote_sent',
  'accepted',
  'declined',
  'rejected',
  'expired',
  'cancelled',
];

async function anyRequest(deps: CleaningDeps, requestId: string): Promise<QuoteRequest> {
  const request = await deps.requests.findById(requestId);
  if (!request) throw CleaningErrors.requestNotFound();
  return request;
}

/** UC-CL-06 : liste des demandes (superviseur, admin), filtrable par état. */
export class ListQuoteRequestsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { page: PageRequest; status: string }): Promise<PageResult<QuoteRequest>> {
    requireStaff(SUPERVISION);
    if (input.status && !REQUEST_STATUSES.includes(input.status as RequestStatus)) {
      throw CleaningErrors.invalid('status');
    }
    const status = (input.status || undefined) as RequestStatus | undefined;
    const now = this.deps.clock.now();
    const result = await this.deps.requests.list(status ? { status } : {}, input.page);
    return { ...result, items: result.items.map((request) => presentRequest(request, now)) };
  }
}

/** UC-CL-06 : détail d'une demande. */
export class GetQuoteRequestUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(requestId: string): Promise<QuoteRequest> {
    requireStaff(SUPERVISION);
    return presentRequest(await anyRequest(this.deps, requestId), this.deps.clock.now());
  }
}

/** UC-CL-06 : refuser une demande, motif obligatoire. */
export class RejectQuoteRequestUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { requestId: string; reason: string }): Promise<QuoteRequest> {
    const staff = requireStaff(SUPERVISION);
    const request = await anyRequest(this.deps, input.requestId);
    const now = this.deps.clock.now();
    assertRequestTransition(request, 'rejected', now);
    const reason = requiredText('reason', input.reason, 500);
    const saved = await saveRequest(
      this.deps,
      { ...request, status: 'rejected', closingReason: reason },
      {
        events: [
          {
            type: 'cleaning.request.cancelled',
            payload: {
              requestId: request.id,
              missionId: null,
              customerId: request.customerId,
              cancelledBy: 'supervisor',
              outcome: 'rejected',
            },
          },
        ],
        audit: [
          {
            actorId: staff.userId,
            action: 'request.rejected',
            entityType: 'quote_request',
            entityId: request.id,
            at: now,
          },
        ],
      },
    );
    return presentRequest(saved, now);
  }
}

/** UC-CL-06, 07 : planifier (ou replanifier) la visite technique avec un agent. */
export class ScheduleVisitUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { requestId: string; scheduledAt: string; agentId: string }): Promise<QuoteRequest> {
    const staff = requireStaff(SUPERVISION);
    const request = await anyRequest(this.deps, input.requestId);
    const now = this.deps.clock.now();
    assertRequestTransition(request, 'visit_scheduled', now);
    const scheduledAt = parseDate('scheduledAt', input.scheduledAt);
    if (scheduledAt <= now) throw CleaningErrors.slotInvalid('La visite doit être planifiée dans le futur.');
    const agentId = requireUuid('agentId', input.agentId);
    const [agent] = await this.deps.agents.findAgents([agentId]);
    if (!agent?.active) throw CleaningErrors.agentNotFound([agentId]);

    const visit = {
      id: request.visit?.status === 'scheduled' ? request.visit.id : this.deps.ids.next(),
      status: 'scheduled' as const,
      scheduledAt,
      agentId,
      report: null,
      completedAt: null,
    };
    const saved = await saveRequest(
      this.deps,
      { ...request, status: 'visit_scheduled', visit },
      {
        events: [
          {
            type: 'cleaning.visit.scheduled',
            payload: {
              requestId: request.id,
              visitId: visit.id,
              customerId: request.customerId,
              agentId,
              scheduledAt: scheduledAt.toISOString(),
            },
          },
        ],
        audit: [
          {
            actorId: staff.userId,
            action: 'visit.scheduled',
            entityType: 'quote_request',
            entityId: request.id,
            at: now,
            details: { visitId: visit.id, agentId },
          },
        ],
      },
    );
    return presentRequest(saved, now);
  }
}

/** UC-CL-07 : compte rendu de la visite technique. */
export class CompleteVisitUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { visitId: string; report: string }): Promise<QuoteRequest> {
    const staff = requireStaff(SUPERVISION);
    const request = await this.deps.requests.findByVisitId(requireUuid('visitId', input.visitId));
    if (!request?.visit) throw CleaningErrors.visitNotFound();
    if (request.visit.status !== 'scheduled')
      throw CleaningErrors.invalidTransition(request.visit.status, 'completed');
    const now = this.deps.clock.now();
    const report = requiredText('report', input.report, 5000);
    const visit = { ...request.visit, status: 'completed' as const, report, completedAt: now };
    const saved = await saveRequest(
      this.deps,
      { ...request, visit },
      {
        events: [],
        audit: [
          {
            actorId: staff.userId,
            action: 'visit.completed',
            entityType: 'quote_request',
            entityId: request.id,
            at: now,
          },
        ],
      },
    );
    return presentRequest(saved, now);
  }
}

export interface SendQuoteInput {
  requestId: string;
  lines: PriceLine[];
  proposedSlots: { start: string; end: string }[];
  validityDays: number;
  recurrence?: { period: string; visitsPerPeriod: number; durationMonths: number };
  teamSize: number;
  durationMinutes: number;
}

/**
 * UC-CL-08 : établir et envoyer le devis. Lignes préremplies depuis la grille en vigueur
 * (avec l'ajustement de commune et le minimum de commande), modifiables ; prix figé à l'envoi.
 */
export class SendQuoteUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: SendQuoteInput): Promise<QuoteRequest> {
    const staff = requireStaff(SUPERVISION);
    const request = await anyRequest(this.deps, input.requestId);
    const now = this.deps.clock.now();
    assertRequestTransition(request, 'quote_sent', now);
    const [service, settings] = await Promise.all([
      this.deps.catalog.findService(request.serviceCode),
      this.deps.catalog.getSettings(),
    ]);
    if (!service) throw CleaningErrors.serviceNotFound();
    const visitNeeded = isVisitRequired(
      request.customerKind,
      service.unit,
      request.quantity,
      settings.visitThresholdSquareMeters,
    );
    if (visitNeeded && request.visit?.status !== 'completed') throw CleaningErrors.visitRequired();

    const lines = input.lines.length ? input.lines : this.prefill(request, service);
    if (!lines.every(isValidLine) || linesSubtotal(lines) < 0) throw CleaningErrors.invalid('lines');
    const count = input.proposedSlots.length;
    if (count < MIN_PROPOSED_SLOTS || count > MAX_PROPOSED_SLOTS) {
      throw CleaningErrors.slotInvalid(`Proposez de ${MIN_PROPOSED_SLOTS} à ${MAX_PROPOSED_SLOTS} créneaux.`);
    }
    const proposedSlots = input.proposedSlots.map((slot, index) =>
      parseSlot(`proposedSlots[${index}]`, slot),
    );
    if (proposedSlots.some((slot) => !respectsLeadTime(slot.start, now, settings.minimumLeadHours))) {
      throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
    }
    const validityDays = input.validityDays
      ? requirePositiveInt('validityDays', input.validityDays, 90)
      : settings.quoteValidityDays;
    const teamSize = input.teamSize
      ? requirePositiveInt('teamSize', input.teamSize, 50)
      : request.recommendedTeamSize;
    const durationMinutes = requirePositiveInt('durationMinutes', input.durationMinutes, 24 * 60);
    const recurrence = input.recurrence?.period ? parseRecurrence(input.recurrence) : request.recurrence;

    const quote = buildQuote({
      id: this.deps.ids.next(),
      lines,
      proposedSlots,
      validityDays,
      depositPercent: settings.depositPercent,
      recurrence,
      teamSize,
      durationMinutes,
      now,
    });
    const saved = await saveRequest(
      this.deps,
      { ...request, status: 'quote_sent', quote },
      {
        events: [
          {
            type: 'cleaning.quote.sent',
            payload: {
              requestId: request.id,
              quoteId: quote.id,
              customerId: request.customerId,
              total: { amount: quote.total, currency: 'XOF' },
              validUntil: quote.validUntil.toISOString(),
            },
          },
        ],
        audit: [
          {
            actorId: staff.userId,
            action: 'quote.sent',
            entityType: 'quote_request',
            entityId: request.id,
            at: now,
            details: {
              quoteId: quote.id,
              subtotal: quote.subtotal,
              total: quote.total,
              pricingVersion: service.pricing.version,
            },
          },
        ],
      },
    );
    return presentRequest(saved, now);
  }

  /** Lignes de la grille ; l'écart dû à la commune ou au minimum devient une ligne d'ajustement. */
  private prefill(request: QuoteRequest, service: ServiceDefinition): PriceLine[] {
    const lines = priceLines(service, request.quantity, request.options);
    const simulation = simulate(service, {
      quantity: request.quantity,
      options: request.options,
      commune: request.commune,
    });
    if (!lines || !simulation.priced) throw CleaningErrors.priceNotSet();
    const adjustment = simulation.computedPrice - linesSubtotal(lines);
    if (adjustment === 0) return lines;
    const label = simulation.minimumApplied
      ? 'Minimum de commande'
      : `Ajustement commune (${request.commune})`;
    return [...lines, { label, quantity: 1, unitPrice: adjustment, amount: adjustment }];
  }
}
