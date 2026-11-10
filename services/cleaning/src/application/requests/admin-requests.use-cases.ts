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
import { FIELD_WORK, requireStaff, seesEverything, SUPERVISION } from '../shared/access';
import { requestForStaff, type StaffRequest } from '../groups/group-support';
import { type Quote } from '../../domain/quote';
import { type Slot } from '../../domain/schedule';
import { type CleaningSettings } from '../../domain/settings';
import { type Changes } from '../ports';
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
import { assertVisitAgentFree } from '../shared/agenda';
import { measure, type MeasurementInput } from './measurements.use-cases';

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

export async function anyRequest(deps: CleaningDeps, requestId: string): Promise<QuoteRequest> {
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
    // Agenda de l'agent (ADR-053) : la visite replanifiée ne se compte pas elle-même.
    await assertVisitAgentFree(
      this.deps,
      agentId,
      scheduledAt,
      request.visit ? [request.visit.id] : [],
      request.groupId,
    );

    // Une demande de la visite commune de son groupe en est détachée : elle reçoit sa propre visite (ADR-035).
    const detachedFrom = request.visit?.status === 'scheduled' ? (request.visit.groupVisitId ?? null) : null;
    const visit = {
      id: request.visit?.status === 'scheduled' ? request.visit.id : this.deps.ids.next(),
      status: 'scheduled' as const,
      scheduledAt,
      agentId,
      report: null,
      completedAt: null,
      groupVisitId: null,
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
            details: { visitId: visit.id, agentId, ...(detachedFrom ? { detachedFrom } : {}) },
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

  async execute(input: {
    visitId: string;
    report: string;
    /** Mesures constatées sur place (ADR-037), facultatives. */
    measurements?: MeasurementInput | undefined;
  }): Promise<StaffRequest> {
    // Ouvert à l'agent affecté à la visite (ADR-035) ; la visite d'un autre agent est introuvable.
    const staff = requireStaff(FIELD_WORK);
    const request = await this.deps.requests.findByVisitId(requireUuid('visitId', input.visitId));
    if (!request?.visit) throw CleaningErrors.visitNotFound();
    if (!seesEverything(staff) && request.visit.agentId !== staff.userId)
      throw CleaningErrors.visitNotFound();
    if (request.visit.status !== 'scheduled')
      throw CleaningErrors.invalidTransition(request.visit.status, 'completed');
    const now = this.deps.clock.now();
    const { blockEarlyVisitReport, timeZone } = this.deps.fieldDates;
    if (blockEarlyVisitReport && isBeforeScheduledTime(now, request.visit.scheduledAt)) {
      throw CleaningErrors.visitTooEarly(request.visit.scheduledAt, timeZone);
    }
    const report = requiredText('report', input.report, 5000);
    const measured = input.measurements
      ? await measure(this.deps, request, input.measurements, staff, 'visit', 'measurements.')
      : null;
    const visit = { ...request.visit, status: 'completed' as const, report, completedAt: now };
    const saved = await saveRequest(
      this.deps,
      { ...(measured?.request ?? request), visit },
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
          ...(measured ? [measured.audit] : []),
        ],
      },
    );
    return requestForStaff(staff, presentRequest(saved, now));
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
    const settings = await this.deps.catalog.getSettings();
    assertRequestTransition(request, 'quote_sent', now);
    const proposedSlots = parseProposedSlots(input.proposedSlots, settings, now);
    const prepared = await prepareQuote(this.deps, request, input, proposedSlots, settings, now);
    const saved = await saveRequest(
      this.deps,
      prepared.request,
      await quoteSentChanges(this.deps, staff.userId, prepared, now),
    );
    return presentRequest(saved, now);
  }
}

/** Créneaux proposés d'un devis : 1 à 3, bien formés, au-delà du délai minimum. */
export function parseProposedSlots(
  slots: { start: string; end: string }[],
  settings: Pick<CleaningSettings, 'minimumLeadHours'>,
  now: Date,
): Slot[] {
  if (slots.length < MIN_PROPOSED_SLOTS || slots.length > MAX_PROPOSED_SLOTS) {
    throw CleaningErrors.slotInvalid(`Proposez de ${MIN_PROPOSED_SLOTS} à ${MAX_PROPOSED_SLOTS} créneaux.`);
  }
  const proposed = slots.map((slot, index) => parseSlot(`proposedSlots[${index}]`, slot));
  if (proposed.some((slot) => !respectsLeadTime(slot.start, now, settings.minimumLeadHours))) {
    throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
  }
  return proposed;
}

export interface PreparedQuote {
  request: QuoteRequest;
  quote: Quote;
  pricingVersion: number;
  /** Lignes préremplies : depuis les mesures constatées, depuis la demande, ou saisies (null). */
  prefilledFrom?: 'measurement' | 'request' | null;
}

/**
 * UC-CL-08 : devis d'une demande, contrôlé et chiffré, pour une demande seule ou pour les devis
 * d'un groupe (ADR-035) ; rien n'est enregistré ici.
 */
export async function prepareQuote(
  deps: CleaningDeps,
  request: QuoteRequest,
  input: Omit<SendQuoteInput, 'requestId' | 'proposedSlots'>,
  proposedSlots: Slot[],
  settings: CleaningSettings,
  now: Date,
): Promise<PreparedQuote> {
  assertRequestTransition(request, 'quote_sent', now);
  const service = await deps.catalog.findService(request.serviceCode);
  if (!service) throw CleaningErrors.serviceNotFound();
  // Visite des lieux réalisée obligatoire avant tout devis (décision du 2026-10-23).
  if (!canSendQuote(request)) throw CleaningErrors.visitRequired();

  const lines = input.lines.length ? input.lines : prefill(request, service);
  // Mesures constatées (ADR-037) : leur calcul donne aussi la taille d'équipe recommandée.
  const measuredTeamSize = request.measurement?.calculation.recommendedTeamSize;
  if (!lines.every(isValidLine) || linesSubtotal(lines) < 0) throw CleaningErrors.invalid('lines');
  const validityDays = input.validityDays
    ? requirePositiveInt('validityDays', input.validityDays, 90)
    : settings.quoteValidityDays;
  const teamSize = input.teamSize
    ? requirePositiveInt('teamSize', input.teamSize, 50)
    : (measuredTeamSize ?? request.recommendedTeamSize);
  const durationMinutes = requirePositiveInt('durationMinutes', input.durationMinutes, 24 * 60);
  const recurrence = input.recurrence?.period ? parseRecurrence(input.recurrence) : request.recurrence;

  const quote = buildQuote({
    id: deps.ids.next(),
    lines,
    proposedSlots,
    validityDays,
    depositPercent: settings.depositPercent,
    recurrence,
    teamSize,
    durationMinutes,
    now,
  });
  return {
    request: { ...request, status: 'quote_sent', quote },
    quote,
    pricingVersion: service.pricing.version,
    prefilledFrom: input.lines.length ? null : request.measurement ? 'measurement' : 'request',
  };
}

/** Événement cleaning.quote.sent et trace d'un devis envoyé. */
export async function quoteSentChanges(
  deps: CleaningDeps,
  actorId: string,
  { request, quote, pricingVersion, prefilledFrom }: PreparedQuote,
  now: Date,
  extra: Record<string, unknown> = {},
  /** Envoi groupé : cleaning.quote_group.sent résume les devis (ADR-035 point 14). */
  summarizedByGroup = false,
): Promise<Changes> {
  const subject = await eventSubject(deps, request);
  return {
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
          ...(summarizedByGroup ? { summarizedByGroup } : {}),
        },
      },
    ],
    audit: [
      {
        actorId,
        action: 'quote.sent',
        entityType: 'quote_request',
        entityId: request.id,
        at: now,
        details: {
          quoteId: quote.id,
          subtotal: quote.subtotal,
          total: quote.total,
          pricingVersion,
          ...(prefilledFrom ? { prefilledFrom } : {}),
          ...extra,
        },
      },
    ],
  };
}

/**
 * Lignes préremplies depuis le détail du calcul des mesures constatées s'il y en a (ADR-037), sinon
 * de la demande (ADR-033), avec une ligne d'ajustement pour les coefficients ou le minimum. Calcul
 * sans prix : nouveau calcul avec la grille en vigueur et les réponses enregistrées (les mesures
 * remplacent celles du client) ; toujours sans prix : CLEANING_PRICE_NOT_SET.
 */
function prefill(request: QuoteRequest, service: ServiceDefinition): PriceLine[] {
  const stored = request.measurement ? request.measurement.calculation : request.calculation;
  const calculation = stored?.priced ? stored : recalculate(request, service);
  const lines = calculation ? quoteLinesFrom(calculation) : null;
  if (!lines) throw CleaningErrors.priceNotSet();
  return lines;
}

/** Nouveau calcul d'une demande avec la grille en vigueur (réponses enregistrées ou ancien format). */
function recalculate(request: QuoteRequest, service: ServiceDefinition): PriceCalculation | null {
  const { measurement } = request;
  const form = measurement
    ? {
        answers: measurement.answers,
        options: measurement.optionSelections,
        frequency: measurement.frequency,
      }
    : request.answers
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
