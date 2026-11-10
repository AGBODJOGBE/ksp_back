import { eventSubject } from '../shared/event-subject';
import { isCovered } from '../../domain/zone';
import { legacyPremisesType, legacyQuantity } from '../../domain/answers';
import { type Mission } from '../../domain/mission';
import { isValidPlan, newPaymentState, type PaymentPlan } from '../../domain/payment';
import { findProposedSlot, isQuoteExpired, type Quote } from '../../domain/quote';
import {
  canTransitionRequest,
  effectiveRequestStatus,
  VISIT_REQUIRED,
  type QuoteRequest,
  type RequestStatus,
} from '../../domain/quote-request';
import { respectsLeadTime, type Slot } from '../../domain/schedule';
import { daysPerWeekOf, requestTiming, type ScheduleInput } from '../shared/schedules';
import { calculatePrice } from '../../domain/simulator';
import { activeService } from '../catalog/catalog.use-cases';
import { type PricingInput, resolveAnswers } from '../catalog/pricing-input';
import { type CleaningDeps, missionView, type MissionView, presentRequest } from '../deps';
import { type Changes } from '../ports';
import { currentCustomer, type Customer } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import {
  optionalText,
  type PageRequest,
  type PageResult,
  parseDate,
  requiredText,
  requirePositiveInt,
} from '../shared/validation';

/** Demande du client, sinon introuvable : jamais révéler l'existence du dossier d'un autre (404). */
export async function ownRequest(
  deps: CleaningDeps,
  customer: Customer,
  requestId: string,
): Promise<QuoteRequest> {
  const request = await deps.requests.findById(requestId);
  if (!request || request.customerId !== customer.userId) throw CleaningErrors.requestNotFound();
  return request;
}

/** Contrôle d'une transition à partir de l'état affiché (un devis périmé est expiré). */
export function assertRequestTransition(request: QuoteRequest, to: RequestStatus, now: Date): void {
  const from = effectiveRequestStatus(request, now);
  if (from === 'expired' && to === 'accepted') throw CleaningErrors.quoteExpired();
  if (!canTransitionRequest(from, to)) throw CleaningErrors.invalidTransition(from, to);
}

export async function saveRequest(
  deps: CleaningDeps,
  request: QuoteRequest,
  changes: Changes,
): Promise<QuoteRequest> {
  const next = { ...request, updatedAt: deps.clock.now() };
  if (!(await deps.requests.save(next, changes))) throw CleaningErrors.concurrentUpdate();
  return { ...next, version: next.version + 1 };
}

/** Demande au nouveau format (answers) ou à l'ancien format déprécié (ADR-033). */
export interface RequestQuoteInput extends PricingInput {
  idempotencyKey: string;
  serviceCode: string;
  commune: string;
  address: string;
  /** 1 à 3 créneaux souhaités ; 0 à 3 avec un plan de passages (le premier passage sinon). */
  preferredSlots: { start: string; end: string }[];
  comment: string;
  /** Dépréciée (ADR-052) : traduite en plan quand c'est exact. */
  recurrence?: { period: string; visitsPerPeriod: number; durationMonths: number };
  /** Plan de passages (ADR-052) : dates exactes, prix estimé sur leur nombre. */
  schedule?: ScheduleInput | null | undefined;
  requestedTeamSize: number;
  /** Entreprise : jours d'intervention par semaine (1 à 7), 0 ou absent si non précisés. */
  daysPerWeek?: number;
}

export { MAX_PREFERRED_SLOTS } from '../shared/schedules';

/**
 * Plan de paiement d'une entreprise : elle règle ses factures mensuelles (service billing) et
 * ne choisit pas d'acompte ; un plan envoyé par le front est ignoré.
 */
export const BUSINESS_PAYMENT_PLAN: PaymentPlan = { option: 'full', timing: 'after', method: 'cash' };

/** UC-CL-02 : demander un devis. Profil complet vérifié par la gateway (IDENTITY_PROFILE_INCOMPLETE). */
export class RequestQuoteUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: RequestQuoteInput): Promise<QuoteRequest> {
    const customer = currentCustomer();
    const key = requiredText('idempotencyKey', input.idempotencyKey, 100);
    const now = this.deps.clock.now();
    const replay = await this.deps.requests.findByIdempotencyKey(customer.userId, key);
    if (replay) return presentRequest(replay, now);
    // Jeton émis avant la suspension de l'organisation (15 minutes au plus, ADR-027) : refusé ici.
    if (customer.organizationId && (await this.deps.organizations.isSuspended(customer.organizationId))) {
      throw CleaningErrors.organizationSuspended();
    }

    const commune = requiredText('commune', input.commune, 100);
    const address = requiredText('address', input.address, 500);
    const comment = optionalText('comment', input.comment, 2000);
    const requestedTeamSize = input.requestedTeamSize
      ? requirePositiveInt('requestedTeamSize', input.requestedTeamSize, 50)
      : 0;
    const daysPerWeek = input.daysPerWeek ? requirePositiveInt('daysPerWeek', input.daysPerWeek, 7) : null;
    const service = await activeService(this.deps, input.serviceCode);
    const { value: form, incomplete } = resolveAnswers(service, input);
    // Zones desservies : une demande hors zone est refusée (le simulateur, lui, reste ouvert).
    if (!isCovered(await this.deps.catalog.listZones(), commune))
      throw CleaningErrors.zoneNotCovered(commune);

    const settings = await this.deps.catalog.getSettings();
    const timing = requestTiming(this.deps, input, settings, now);
    if ((await this.deps.requests.countOpen(customer.userId, now)) >= settings.maxOpenRequests) {
      throw CleaningErrors.tooManyOpenRequests(settings.maxOpenRequests);
    }

    const calculation = calculatePrice(service, { ...form, commune, requestedTeamSize, incomplete });
    const visitRequired = VISIT_REQUIRED;
    const request: QuoteRequest = {
      id: this.deps.ids.next(),
      status: 'received',
      customerId: customer.userId,
      customerKind: customer.kind,
      organizationId: customer.organizationId,
      serviceCode: service.code,
      premisesType: legacyPremisesType(form.answers),
      quantity: legacyQuantity(service, form.answers),
      options: form.options.map((option) => option.code),
      answers: form.answers,
      optionSelections: form.options,
      frequency: form.frequency,
      pricingVersion: service.pricing.version,
      calculation,
      commune,
      address,
      groupId: null,
      placeType: null,
      location: null,
      landmark: null,
      geocodingProvider: null,
      geocodedAddress: null,
      ...timing,
      comment,
      requestedTeamSize,
      daysPerWeek: daysPerWeekOf(daysPerWeek, timing.schedule),
      recommendedTeamSize: calculation.recommendedTeamSize,
      estimate: calculation.estimate,
      visit: null,
      quote: null,
      missionId: null,
      closingReason: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    const result = await this.deps.requests.create(request, key, {
      events: [
        {
          type: 'cleaning.quote.requested',
          payload: {
            requestId: request.id,
            customerId: customer.userId,
            organizationId: customer.organizationId,
            customerKind: customer.kind,
            serviceCode: service.code,
            ...(service.name ? { serviceName: service.name } : {}),
            visitRequired,
          },
        },
      ],
      audit: [
        {
          actorId: customer.userId,
          action: 'request.created',
          entityType: 'quote_request',
          entityId: request.id,
          at: now,
        },
      ],
    });
    return presentRequest(result.value, now);
  }
}

/** UC-CL-03 : mes demandes. */
export class ListMyRequestsUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(page: PageRequest): Promise<PageResult<QuoteRequest>> {
    const customer = currentCustomer();
    const now = this.deps.clock.now();
    const result = await this.deps.requests.list({ customerId: customer.userId }, page);
    return { ...result, items: result.items.map((request) => presentRequest(request, now)) };
  }
}

/** UC-CL-03 : détail d'une de mes demandes. */
export class GetMyRequestUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(requestId: string): Promise<QuoteRequest> {
    return presentRequest(await ownRequest(this.deps, currentCustomer(), requestId), this.deps.clock.now());
  }
}

export interface AcceptQuoteInput {
  requestId: string;
  idempotencyKey: string;
  slotStart: string;
  /** Obligatoire pour un particulier, ignoré pour une entreprise. */
  paymentPlan?: { option: string; timing: string; method: string } | undefined;
}

const PAYMENT_PLAN_REQUIRED_MESSAGE =
  'Choisissez votre option de paiement : acompte ou totalité, avant ou après la mission, et le moyen de paiement.';

/** Plan de la mission : celui de l'entreprise, ou celui choisi par le particulier (obligatoire). */
export function paymentPlanFor(request: QuoteRequest, input: AcceptQuoteInput['paymentPlan']): PaymentPlan {
  if (request.customerKind === 'business') return BUSINESS_PAYMENT_PLAN;
  // Message protobuf absent : décodé à null par le serveur gRPC ; un plan vide est refusé de même.
  if (!input?.option) throw CleaningErrors.invalid('paymentPlan', PAYMENT_PLAN_REQUIRED_MESSAGE);
  const plan = input as PaymentPlan;
  if (!isValidPlan(plan)) throw CleaningErrors.invalid('paymentPlan', "L'option de paiement est invalide.");
  return plan;
}

/** Mission créée par l'acceptation d'un devis (demande seule ou acceptation de groupe, ADR-035). */
export function newMission(
  deps: CleaningDeps,
  request: QuoteRequest,
  quote: Quote,
  slot: Slot,
  plan: PaymentPlan,
  now: Date,
): Mission {
  return {
    id: deps.ids.next(),
    requestId: request.id,
    quoteId: quote.id,
    customerId: request.customerId,
    organizationId: request.organizationId,
    status: 'to_schedule',
    serviceCode: request.serviceCode,
    commune: request.commune,
    address: request.address,
    // Position et repère copiés de la demande (ADR-034) : les agents vont sur place.
    location: request.location,
    landmark: request.landmark,
    groupId: request.groupId,
    placeType: request.placeType,
    chosenSlot: slot,
    recurrence: quote.recurrence,
    // Plan de passages du devis (ADR-052) : ses dates sont celles des passages à planifier.
    schedule: quote.schedule ?? null,
    scheduledDates: quote.scheduledDates ?? [],
    plannedInterventions: quote.interventionCount,
    interventions: [],
    payment: newPaymentState(
      { option: plan.option, timing: plan.timing, method: plan.method },
      quote.total,
      quote.depositPercent,
    ),
    cancellationReason: null,
    daysPerWeek: request.daysPerWeek,
    suspension: null,
    warningLevel: 0,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

/** Événement cleaning.booking.confirmed et trace de l'acceptation d'un devis. */
export async function bookingChanges(
  deps: CleaningDeps,
  actorId: string,
  request: QuoteRequest,
  quote: Quote,
  mission: Mission,
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<Changes> {
  const subject = await eventSubject(deps, request);
  return {
    events: [
      {
        type: 'cleaning.booking.confirmed',
        payload: {
          ...subject,
          requestId: request.id,
          quoteId: quote.id,
          missionId: mission.id,
          customerId: request.customerId,
          organizationId: request.organizationId,
          total: { amount: quote.total, currency: 'XOF' },
          plannedInterventions: quote.interventionCount,
          recurrence: quote.recurrence,
          ...schedulePeriod(quote.scheduledDates),
          paymentPlan: mission.payment.plan,
          depositAmount: { amount: mission.payment.depositAmount, currency: 'XOF' },
          startsAt: mission.chosenSlot.start.toISOString(),
        },
      },
    ],
    audit: [
      {
        actorId,
        action: 'quote.accepted',
        entityType: 'quote_request',
        entityId: request.id,
        at: now,
        details: {
          missionId: mission.id,
          quoteId: quote.id,
          total: quote.total,
          payment: mission.payment.plan,
          ...extra,
        },
      },
    ],
  };
}

/** Premier et dernier passage d'un plan (ADR-052), pour billing ; rien sans plan. */
function schedulePeriod(dates: string[] | undefined) {
  const [firstDate, lastDate] = [dates?.[0], dates?.at(-1)];
  return firstDate && lastDate ? { schedulePeriod: { firstDate, lastDate } } : {};
}

/** UC-CL-04 : accepter le devis ; la mission est créée avec l'option de paiement choisie. */
export class AcceptQuoteUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: AcceptQuoteInput): Promise<{ request: QuoteRequest; mission: MissionView }> {
    const customer = currentCustomer();
    const key = requiredText('idempotencyKey', input.idempotencyKey, 100);
    const request = await ownRequest(this.deps, customer, input.requestId);
    const now = this.deps.clock.now();

    const replayed = await this.deps.requests.findAcceptance(request.id, key);
    if (replayed) return this.result(request.id, replayed);

    assertRequestTransition(request, 'accepted', now);
    const quote = request.quote;
    if (!quote) throw CleaningErrors.invalidTransition(request.status, 'accepted');
    if (isQuoteExpired(quote, now)) throw CleaningErrors.quoteExpired();
    const slot = findProposedSlot(quote, parseDate('slotStart', input.slotStart));
    if (!slot) throw CleaningErrors.slotInvalid('Choisissez un des créneaux proposés dans le devis.');
    const settings = await this.deps.catalog.getSettings();
    if (!respectsLeadTime(slot.start, now, settings.minimumLeadHours)) {
      throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
    }
    const plan = paymentPlanFor(request, input.paymentPlan);

    const mission = newMission(this.deps, request, quote, slot, plan, now);
    const accepted: QuoteRequest = { ...request, status: 'accepted', missionId: mission.id, updatedAt: now };
    const outcome = await this.deps.requests.accept(
      accepted,
      mission,
      key,
      await bookingChanges(this.deps, customer.userId, request, quote, mission, now),
    );
    if (outcome.status === 'conflict') throw CleaningErrors.concurrentUpdate();
    // L'acceptation se fait au nom du titulaire, quel que soit son contexte actif : c'est la
    // demande qui porte l'organisation (ADR-030).
    if (outcome.status === 'organization_suspended') throw CleaningErrors.organizationSuspended();
    return this.result(request.id, outcome.status === 'replayed' ? outcome.missionId : mission.id);
  }

  private async result(requestId: string, missionId: string) {
    const [request, mission] = await Promise.all([
      this.deps.requests.findById(requestId),
      this.deps.missions.findById(missionId),
    ]);
    if (!request || !mission) throw CleaningErrors.missionNotFound();
    return {
      request: presentRequest(request, this.deps.clock.now()),
      mission: await missionView(this.deps, mission),
    };
  }
}

/** UC-CL-04 : refuser le devis (motif facultatif) ; la demande est close. */
export class DeclineQuoteUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { requestId: string; reason: string }): Promise<QuoteRequest> {
    return closeByCustomer(this.deps, input, 'declined');
  }
}

/** UC-CL-05 : annuler une demande encore ouverte. */
export class CancelRequestUseCase {
  constructor(private readonly deps: CleaningDeps) {}

  async execute(input: { requestId: string; reason: string }): Promise<QuoteRequest> {
    return closeByCustomer(this.deps, input, 'cancelled');
  }
}

/**
 * Événement cleaning.request.cancelled et trace d'une demande close par le client ou refusée par
 * la supervision (demande seule ou opération de groupe, ADR-035).
 */
export async function closingChanges(
  deps: CleaningDeps,
  actorId: string,
  request: QuoteRequest,
  to: 'declined' | 'cancelled' | 'rejected',
  now: Date,
  extra: Record<string, unknown> | null = null,
): Promise<Changes> {
  const subject = await eventSubject(deps, request);
  return {
    events: [
      {
        type: 'cleaning.request.cancelled',
        payload: {
          ...subject,
          requestId: request.id,
          missionId: null,
          customerId: request.customerId,
          organizationId: request.organizationId,
          cancelledBy: to === 'rejected' ? 'supervisor' : 'customer',
          outcome: to,
        },
      },
    ],
    audit: [
      {
        actorId,
        action: `request.${to}`,
        entityType: 'quote_request',
        entityId: request.id,
        at: now,
        ...(extra ? { details: extra } : {}),
      },
    ],
  };
}

async function closeByCustomer(
  deps: CleaningDeps,
  input: { requestId: string; reason: string },
  to: 'declined' | 'cancelled',
): Promise<QuoteRequest> {
  const customer = currentCustomer();
  const request = await ownRequest(deps, customer, input.requestId);
  const now = deps.clock.now();
  assertRequestTransition(request, to, now);
  const reason = optionalText('reason', input.reason, 500);
  const saved = await saveRequest(
    deps,
    { ...request, status: to, closingReason: reason },
    await closingChanges(deps, customer.userId, request, to, now),
  );
  return presentRequest(saved, now);
}
