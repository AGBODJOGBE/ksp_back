import { eventSubject } from '../shared/event-subject';
import { checkAnswers, convertLegacy } from '../../domain/answers';
import { isCode, type ServiceDefinition } from '../../domain/catalog';
import {
  buildQuote,
  isValidLine,
  linesSubtotal,
  MAX_PROPOSED_SLOTS,
  MIN_PROPOSED_SLOTS,
} from '../../domain/quote';
import {
  canSendQuote,
  type CustomerKind,
  type QuoteRequest,
  type RequestStatus,
} from '../../domain/quote-request';
import { isBeforeScheduledTime, respectsLeadTime } from '../../domain/schedule';
import { isValidZoneCode, zoneCode } from '../../domain/zone';
import { type QuoteRequestFilter } from '../ports';
import {
  calculatePrice,
  type PriceCalculation,
  type PriceLine,
  quoteLinesFrom,
} from '../../domain/simulator';
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

const CUSTOMER_KINDS: readonly CustomerKind[] = ['individual', 'business'];

export interface ListQuoteRequestsInput {
  page: PageRequest;
  /** Filtres facultatifs et cumulables ; chaîne vide = sans filtre. */
  status: string;
  /** Code de zone (« abomey-calavi ») ; un nom de commune est accepté et normalisé. */
  commune?: string;
  customerKind?: string;
  /** Parcours par lieu (ADR-034) : groupe, type de lieu, prestation. */
  groupId?: string;
  placeType?: string;
  serviceCode?: string;
}

/** UC-CL-06 : liste des demandes (superviseur, admin), filtrable par état, zone et type de client. */
export class ListQuoteRequestsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: ListQuoteRequestsInput): Promise<PageResult<QuoteRequest>> {
    requireStaff(SUPERVISION);
    const filter: QuoteRequestFilter = {};
    if (input.status) {
      if (!REQUEST_STATUSES.includes(input.status as RequestStatus)) throw CleaningErrors.invalid('status');
      filter.status = input.status as RequestStatus;
    }
    if (input.commune) {
      const code = zoneCode(input.commune);
      if (!isValidZoneCode(code)) throw CleaningErrors.invalid('commune', 'Code de zone invalide.');
      filter.communeCode = code;
    }
    if (input.customerKind) {
      if (!CUSTOMER_KINDS.includes(input.customerKind as CustomerKind)) {
        throw CleaningErrors.invalid('customerKind');
      }
      filter.customerKind = input.customerKind as CustomerKind;
    }
    if (input.groupId) filter.groupId = requireUuid('groupId', input.groupId);
    if (input.placeType) {
      if (!isCode(input.placeType)) throw CleaningErrors.invalid('placeType');
      filter.placeType = input.placeType;
    }
    if (input.serviceCode) {
      if (!isCode(input.serviceCode)) throw CleaningErrors.invalid('serviceCode');
      filter.serviceCode = input.serviceCode;
    }
    const now = this.deps.clock.now();
    const result = await this.deps.requests.list(filter, input.page);
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
    const subject = await eventSubject(this.deps, request);
    const saved = await saveRequest(
      this.deps,
      { ...request, status: 'rejected', closingReason: reason },
      {
        events: [
          {
            type: 'cleaning.request.cancelled',
            payload: {
              ...subject,
              requestId: request.id,
              missionId: null,
              customerId: request.customerId,
              organizationId: request.organizationId,
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
    const subject = await eventSubject(this.deps, request);
    const saved = await saveRequest(
      this.deps,
      { ...request, status: 'visit_scheduled', visit },
      {
        events: [
          {
            type: 'cleaning.visit.scheduled',
            payload: {
              ...subject,
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

/**
 * UC-CL-07 : compte rendu de la visite technique. Refusé avant l'heure prévue de la visite
 * (CLEANING_VISIT_TOO_EARLY), sauf si la règle est désactivée par configuration (à valider).
 */
export class CompleteVisitUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { visitId: string; report: string }): Promise<QuoteRequest> {
    const staff = requireStaff(SUPERVISION);
    const request = await this.deps.requests.findByVisitId(requireUuid('visitId', input.visitId));
    if (!request?.visit) throw CleaningErrors.visitNotFound();
    if (request.visit.status !== 'scheduled')
      throw CleaningErrors.invalidTransition(request.visit.status, 'completed');
    const now = this.deps.clock.now();
    const { blockEarlyVisitReport, timeZone } = this.deps.fieldDates;
    if (blockEarlyVisitReport && isBeforeScheduledTime(now, request.visit.scheduledAt)) {
      throw CleaningErrors.visitTooEarly(request.visit.scheduledAt, timeZone);
    }
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
 * UC-CL-08 : établir et envoyer le devis. Lignes préremplies depuis le détail du calcul de la
 * demande (avec l'ajustement des coefficients et le minimum de commande), modifiables ; prix figé à l'envoi.
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
    // Visite des lieux réalisée obligatoire avant tout devis (décision du 2026-10-23).
    if (!canSendQuote(request)) throw CleaningErrors.visitRequired();

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
    const subject = await eventSubject(this.deps, request);
    const saved = await saveRequest(
      this.deps,
      { ...request, status: 'quote_sent', quote },
      {
        events: [
          {
            type: 'cleaning.quote.sent',
            payload: {
              ...subject,
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

  /**
   * Lignes préremplies depuis le détail du calcul de la demande (ADR-033), avec une ligne
   * d'ajustement pour les coefficients ou le minimum. Calcul sans prix : nouveau calcul avec la
   * grille en vigueur et les réponses enregistrées ; toujours sans prix : CLEANING_PRICE_NOT_SET.
   */
  private prefill(request: QuoteRequest, service: ServiceDefinition): PriceLine[] {
    const calculation = request.calculation?.priced ? request.calculation : recalculate(request, service);
    const lines = calculation ? quoteLinesFrom(calculation) : null;
    if (!lines) throw CleaningErrors.priceNotSet();
    return lines;
  }
}

/** Nouveau calcul d'une demande avec la grille en vigueur (réponses enregistrées ou ancien format). */
function recalculate(request: QuoteRequest, service: ServiceDefinition): PriceCalculation | null {
  const form = request.answers
    ? { answers: request.answers, options: request.optionSelections, frequency: request.frequency }
    : convertLegacy(service, {
        premisesType: request.premisesType,
        quantity: request.quantity,
        options: request.options,
        frequency: null,
      });
  if (!form) return null;
  const check = checkAnswers(service, form, true);
  if (!check.ok) return null;
  return calculatePrice(service, {
    ...check.value,
    commune: request.commune,
    requestedTeamSize: request.requestedTeamSize,
    incomplete: check.incomplete,
  });
}
