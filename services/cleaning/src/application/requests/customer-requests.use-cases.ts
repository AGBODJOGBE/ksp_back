import { isCovered } from '../../domain/zone';
import { PREMISES_TYPES, recommendedTeamSize } from '../../domain/catalog';
import { type Mission } from '../../domain/mission';
import { isValidPlan, newPaymentState, type PaymentPlan } from '../../domain/payment';
import { findProposedSlot, isQuoteExpired } from '../../domain/quote';
import {
  canTransitionRequest,
  effectiveRequestStatus,
  VISIT_REQUIRED,
  type QuoteRequest,
  type RequestStatus,
} from '../../domain/quote-request';
import { respectsLeadTime } from '../../domain/schedule';
import { simulate, unknownOptions } from '../../domain/simulator';
import { activeService } from '../catalog/catalog.use-cases';
import { type CleaningDeps, missionView, type MissionView, presentRequest } from '../deps';
import { type Changes } from '../ports';
import { currentCustomer, type Customer } from '../shared/access';
import { CleaningErrors } from '../shared/errors';
import {
  oneOf,
  optionalText,
  type PageRequest,
  type PageResult,
  parseDate,
  parseRecurrence,
  parseSlot,
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

export interface RequestQuoteInput {
  idempotencyKey: string;
  serviceCode: string;
  premisesType: string;
  quantity: number;
  options: string[];
  commune: string;
  address: string;
  preferredSlots: { start: string; end: string }[];
  comment: string;
  recurrence?: { period: string; visitsPerPeriod: number; durationMonths: number };
  requestedTeamSize: number;
  /** Entreprise : jours d'intervention par semaine (1 à 7), 0 ou absent si non précisés. */
  daysPerWeek?: number;
}

export const MAX_PREFERRED_SLOTS = 3;

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

    const premisesType = oneOf('premisesType', input.premisesType, PREMISES_TYPES);
    const quantity = requirePositiveInt('quantity', input.quantity);
    const commune = requiredText('commune', input.commune, 100);
    const address = requiredText('address', input.address, 500);
    const comment = optionalText('comment', input.comment, 2000);
    const recurrence = parseRecurrence(input.recurrence);
    const requestedTeamSize = input.requestedTeamSize
      ? requirePositiveInt('requestedTeamSize', input.requestedTeamSize, 50)
      : 0;
    const daysPerWeek = input.daysPerWeek ? requirePositiveInt('daysPerWeek', input.daysPerWeek, 7) : null;
    const service = await activeService(this.deps, input.serviceCode);
    if (unknownOptions(service, input.options).length) throw CleaningErrors.invalid('options');
    // Zones desservies : une demande hors zone est refusée (le simulateur, lui, reste ouvert).
    if (!isCovered(await this.deps.catalog.listZones(), commune))
      throw CleaningErrors.zoneNotCovered(commune);

    const settings = await this.deps.catalog.getSettings();
    if (input.preferredSlots.length < 1 || input.preferredSlots.length > MAX_PREFERRED_SLOTS) {
      throw CleaningErrors.slotInvalid(`Proposez de 1 à ${MAX_PREFERRED_SLOTS} créneaux.`);
    }
    const preferredSlots = input.preferredSlots.map((slot, index) =>
      parseSlot(`preferredSlots[${index}]`, slot),
    );
    if (preferredSlots.some((slot) => !respectsLeadTime(slot.start, now, settings.minimumLeadHours))) {
      throw CleaningErrors.leadTimeTooShort(settings.minimumLeadHours);
    }
    if ((await this.deps.requests.countOpen(customer.userId, now)) >= settings.maxOpenRequests) {
      throw CleaningErrors.tooManyOpenRequests(settings.maxOpenRequests);
    }

    const options = [...new Set(input.options)];
    const simulation = simulate(service, { quantity, options, commune, requestedTeamSize });
    const visitRequired = VISIT_REQUIRED;
    const request: QuoteRequest = {
      id: this.deps.ids.next(),
      status: 'received',
      customerId: customer.userId,
      customerKind: customer.kind,
      organizationId: customer.organizationId,
      serviceCode: service.code,
      premisesType,
      quantity,
      options,
      commune,
      address,
      preferredSlots,
      comment,
      recurrence,
      requestedTeamSize,
      daysPerWeek,
      recommendedTeamSize: recommendedTeamSize(service.pricing.teamSize, quantity, requestedTeamSize),
      estimate: simulation.priced ? { low: simulation.low, high: simulation.high } : null,
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
function paymentPlanFor(request: QuoteRequest, input: AcceptQuoteInput['paymentPlan']): PaymentPlan {
  if (request.customerKind === 'business') return BUSINESS_PAYMENT_PLAN;
  // Message protobuf absent : décodé à null par le serveur gRPC ; un plan vide est refusé de même.
  if (!input?.option) throw CleaningErrors.invalid('paymentPlan', PAYMENT_PLAN_REQUIRED_MESSAGE);
  const plan = input as PaymentPlan;
  if (!isValidPlan(plan)) throw CleaningErrors.invalid('paymentPlan', "L'option de paiement est invalide.");
  return plan;
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

    const mission: Mission = {
      id: this.deps.ids.next(),
      requestId: request.id,
      quoteId: quote.id,
      customerId: request.customerId,
      organizationId: request.organizationId,
      status: 'to_schedule',
      serviceCode: request.serviceCode,
      commune: request.commune,
      address: request.address,
      chosenSlot: slot,
      recurrence: quote.recurrence,
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
    const accepted: QuoteRequest = { ...request, status: 'accepted', missionId: mission.id, updatedAt: now };
    const outcome = await this.deps.requests.accept(accepted, mission, key, {
      events: [
        {
          type: 'cleaning.booking.confirmed',
          payload: {
            requestId: request.id,
            quoteId: quote.id,
            missionId: mission.id,
            customerId: request.customerId,
            organizationId: request.organizationId,
            total: { amount: quote.total, currency: 'XOF' },
            plannedInterventions: quote.interventionCount,
            recurrence: quote.recurrence,
            paymentPlan: mission.payment.plan,
            depositAmount: { amount: mission.payment.depositAmount, currency: 'XOF' },
            startsAt: slot.start.toISOString(),
          },
        },
      ],
      audit: [
        {
          actorId: customer.userId,
          action: 'quote.accepted',
          entityType: 'quote_request',
          entityId: request.id,
          at: now,
          details: {
            missionId: mission.id,
            quoteId: quote.id,
            total: quote.total,
            payment: mission.payment.plan,
          },
        },
      ],
    });
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
    {
      events: [
        {
          type: 'cleaning.request.cancelled',
          payload: {
            requestId: request.id,
            missionId: null,
            customerId: request.customerId,
            cancelledBy: 'customer',
            outcome: to,
          },
        },
      ],
      audit: [
        {
          actorId: customer.userId,
          action: `request.${to}`,
          entityType: 'quote_request',
          entityId: request.id,
          at: now,
        },
      ],
    },
  );
  return presentRequest(saved, now);
}
