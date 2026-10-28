import { type Zone } from '../../domain/zone';
import { type cleaningV1 } from '@ksp/contracts';
import { type NameBook, NO_NAMES } from '../../application/backoffice/backoffice-names.use-case';
import { type MissionView } from '../../application/deps';
import { type StoredSettings } from '../../application/ports';
import { type Agent, type Team } from '../../domain/agent';
import { type ServiceDefinition } from '../../domain/catalog';
import { CURRENCY } from '../../domain/money';
import { paidAmount, paymentStatus } from '../../domain/payment';
import { type Quote } from '../../domain/quote';
import { type QuoteRequest } from '../../domain/quote-request';
import { type Recurrence } from '../../domain/recurrence';
import { type Slot } from '../../domain/schedule';
import { type PriceLine } from '../../domain/simulator';

/** Traduction du modèle vers les messages du contrat : dates ISO 8601, chaîne vide = absente. */
export const money = (amount: number) => ({ amount, currency: CURRENCY });
const iso = (date: Date | null | undefined) => (date ? date.toISOString() : '');
const text = (value: string | null | undefined) => value ?? '';
/** Nom affiché au back-office (ADR-029) ; chaîne vide s'il est inconnu. */
const userName = (names: NameBook, userId: string | null | undefined) =>
  (userId && names.users.get(userId)) || '';
const organizationName = (names: NameBook, organizationId: string | null | undefined) =>
  (organizationId && names.organizations.get(organizationId)) || '';

export const presentSlot = (slot: Slot): cleaningV1.TimeSlot => ({
  start: iso(slot.start),
  end: iso(slot.end),
});

const presentRecurrence = (recurrence: Recurrence | null): cleaningV1.Recurrence | undefined =>
  recurrence ? { ...recurrence } : undefined;

export const presentLine = (line: PriceLine): cleaningV1.PriceLine => ({
  label: line.label,
  quantity: line.quantity,
  unitPrice: money(line.unitPrice),
  amount: money(line.amount),
});

function presentQuote(quote: Quote): cleaningV1.Quote {
  return {
    id: quote.id,
    lines: quote.lines.map(presentLine),
    subtotal: money(quote.subtotal),
    interventionCount: quote.interventionCount,
    total: money(quote.total),
    proposedSlots: quote.proposedSlots.map(presentSlot),
    validUntil: iso(quote.validUntil),
    depositPercent: quote.depositPercent,
    depositAmount: money(quote.depositAmount),
    recurrence: presentRecurrence(quote.recurrence),
    sentAt: iso(quote.sentAt),
    teamSize: quote.teamSize,
    durationMinutes: quote.durationMinutes,
  };
}

/** Demande ; les noms (back-office) restent vides sans annuaire, par exemple dans l'espace client. */
export function presentRequest(request: QuoteRequest, names: NameBook = NO_NAMES): cleaningV1.QuoteRequest {
  return {
    id: request.id,
    status: request.status,
    customerId: request.customerId,
    customerKind: request.customerKind,
    organizationId: text(request.organizationId),
    serviceCode: request.serviceCode,
    premisesType: request.premisesType,
    quantity: request.quantity,
    options: request.options,
    commune: request.commune,
    address: request.address,
    preferredSlots: request.preferredSlots.map(presentSlot),
    comment: text(request.comment),
    recurrence: presentRecurrence(request.recurrence),
    requestedTeamSize: request.requestedTeamSize,
    recommendedTeamSize: request.recommendedTeamSize,
    estimate: request.estimate
      ? { low: money(request.estimate.low), high: money(request.estimate.high) }
      : undefined,
    visit: request.visit
      ? {
          id: request.visit.id,
          status: request.visit.status,
          scheduledAt: iso(request.visit.scheduledAt),
          agentId: request.visit.agentId,
          report: text(request.visit.report),
          completedAt: iso(request.visit.completedAt),
          agentName: userName(names, request.visit.agentId),
        }
      : undefined,
    quote: request.quote ? presentQuote(request.quote) : undefined,
    missionId: text(request.missionId),
    closingReason: text(request.closingReason),
    createdAt: iso(request.createdAt),
    updatedAt: iso(request.updatedAt),
    daysPerWeek: request.daysPerWeek ?? 0,
    customerName: userName(names, request.customerId),
    organizationName: organizationName(names, request.organizationId),
  };
}

export function presentMission(
  { mission, agentNames }: MissionView,
  names: NameBook = NO_NAMES,
): cleaningV1.Mission {
  const { payment } = mission;
  return {
    id: mission.id,
    requestId: mission.requestId,
    quoteId: mission.quoteId,
    customerId: mission.customerId,
    status: mission.status,
    serviceCode: mission.serviceCode,
    commune: mission.commune,
    address: mission.address,
    chosenSlot: presentSlot(mission.chosenSlot),
    recurrence: presentRecurrence(mission.recurrence),
    plannedInterventions: mission.plannedInterventions,
    completedInterventions: mission.interventions.filter((i) => i.status === 'completed').length,
    interventions: mission.interventions.map((intervention) => ({
      id: intervention.id,
      status: intervention.status,
      scheduledStart: iso(intervention.scheduledStart),
      durationMinutes: intervention.durationMinutes,
      agents: intervention.agentIds.map((agentId) => ({ agentId, displayName: agentNames[agentId] ?? '' })),
      checklist: intervention.checklist.map((item) => ({ ...item })),
      incidentNote: text(intervention.incidentNote),
      beforePhotoFileIds: intervention.beforePhotoFileIds,
      afterPhotoFileIds: intervention.afterPhotoFileIds,
      startedAt: iso(intervention.startedAt),
      completedAt: iso(intervention.completedAt),
      cancellationCause: intervention.cancellationCause ?? '',
    })),
    payment: {
      plan: { ...payment.plan },
      status: paymentStatus(payment),
      total: money(payment.total),
      depositPercent: payment.depositPercent,
      depositAmount: money(payment.depositAmount),
      paid: money(paidAmount(payment)),
      payments: payment.payments.map((record) => ({
        id: record.id,
        amount: money(record.amount),
        method: record.method,
        reference: text(record.reference),
        recordedBy: record.recordedBy,
        recordedAt: iso(record.recordedAt),
        recordedByName: userName(names, record.recordedBy),
      })),
    },
    cancellationReason: text(mission.cancellationReason),
    createdAt: iso(mission.createdAt),
    updatedAt: iso(mission.updatedAt),
    suspension: mission.suspension
      ? {
          cause: mission.suspension.causes[0]!,
          causes: mission.suspension.causes,
          since: iso(mission.suspension.since),
          unpaidCount: mission.suspension.unpaidCount,
        }
      : undefined,
    daysPerWeek: mission.daysPerWeek ?? 0,
    customerKind: mission.organizationId ? 'business' : 'individual',
    organizationId: text(mission.organizationId),
    customerName: userName(names, mission.customerId),
    organizationName: organizationName(names, mission.organizationId),
  };
}

const optionalMoney = (amount: number | null) => (amount === null ? undefined : money(amount));

export function presentOffer(service: ServiceDefinition): cleaningV1.ServiceOffer {
  return {
    code: service.code,
    name: service.name,
    description: service.description,
    unit: service.unit,
    options: service.pricing.options.map((option) => ({
      code: option.code,
      label: option.label,
      price: optionalMoney(option.price),
    })),
    priced: service.pricing.unitPrice !== null,
    minimumPrice: optionalMoney(service.pricing.minimumPrice),
  };
}

export function presentDefinition(
  service: ServiceDefinition,
  names: NameBook = NO_NAMES,
): cleaningV1.ServiceDefinition {
  const { pricing } = service;
  return {
    code: service.code,
    name: service.name,
    description: service.description,
    unit: service.unit,
    active: service.active,
    pricing: {
      version: pricing.version,
      unitPrice: optionalMoney(pricing.unitPrice),
      minimumPrice: optionalMoney(pricing.minimumPrice),
      options: pricing.options.map((option) => ({
        code: option.code,
        label: option.label,
        price: optionalMoney(option.price),
      })),
      communeCoefficients: Object.entries(pricing.communeCoefficients).map(([commune, coefficientBp]) => ({
        commune,
        coefficientBp,
      })),
      defaultCoefficientBp: pricing.defaultCoefficientBp,
      teamSize: { ...pricing.teamSize },
      checklist: pricing.checklist.map((item) => ({ ...item, done: false })),
      updatedBy: pricing.updatedBy,
      updatedAt: pricing.version ? iso(pricing.updatedAt) : '',
      updatedByName: userName(names, pricing.updatedBy),
    },
  };
}

export function presentSettings(settings: StoredSettings, names: NameBook = NO_NAMES): cleaningV1.Settings {
  return {
    quoteValidityDays: settings.quoteValidityDays,
    minimumLeadHours: settings.minimumLeadHours,
    freeCancellationHours: settings.freeCancellationHours,
    visitThresholdSquareMeters: settings.visitThresholdSquareMeters,
    maxOpenRequests: settings.maxOpenRequests,
    depositPercent: settings.depositPercent,
    businessWarningUnpaidInvoices: settings.businessWarningUnpaidInvoices,
    businessSuspensionUnpaidInvoices: settings.businessSuspensionUnpaidInvoices,
    individualSuspensionUnpaidInterventions: settings.individualSuspensionUnpaidInterventions,
    individualPaymentGraceHours: settings.individualPaymentGraceHours,
    updatedBy: text(settings.updatedBy),
    updatedAt: iso(settings.updatedAt),
    updatedByName: userName(names, settings.updatedBy),
  };
}

export function presentAgent(agent: Agent): cleaningV1.Agent {
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    active: agent.active,
    unavailabilities: agent.unavailabilities.map((u) => ({
      id: u.id,
      start: iso(u.slot.start),
      end: iso(u.slot.end),
      reason: text(u.reason),
    })),
  };
}

export function presentTeam(team: Team, agents: Agent[]): cleaningV1.Team {
  const names = new Map(agents.map((agent) => [agent.agentId, agent.displayName]));
  return {
    id: team.id,
    name: team.name,
    members: team.memberIds.map((agentId) => ({ agentId, displayName: names.get(agentId) ?? '' })),
  };
}

/** Zone vue du public : code et nom affiché, sans les champs d'administration. */
export function presentServedZone(zone: Zone): cleaningV1.ServedZone {
  return { code: zone.code, commune: zone.commune };
}

export function presentZone(zone: Zone, names: NameBook = NO_NAMES): cleaningV1.Zone {
  return {
    code: zone.code,
    commune: zone.commune,
    active: zone.active,
    updatedBy: text(zone.updatedBy),
    updatedAt: iso(zone.updatedAt),
    updatedByName: userName(names, zone.updatedBy),
  };
}
