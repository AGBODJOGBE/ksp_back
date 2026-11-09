import { type Zone, zoneCode } from '../../domain/zone';
import { type cleaningV1 } from '@ksp/contracts';
import { type NameBook, NO_NAMES } from '../../application/backoffice/backoffice-names.use-case';
import { type MissionView } from '../../application/deps';
import { type PlaceTypeView } from '../../application/places/place-catalog.use-cases';
import { NO_LABELS, type RequestLabels } from '../../application/places/request-labels.use-case';
import { type GroupOutcome, type QuoteRequestGroupView, type StoredSettings } from '../../application/ports';
import { type VisitView } from '../../application/groups/group-visits.use-cases';
import { type StaffRequest } from '../../application/groups/group-support';
import { type ZoneView } from '../../application/catalog/zones.use-cases';
import { type GroupTotals } from '../../application/groups/group-totals.use-case';
import { type GeoLocation } from '../../domain/location';
import { type PlaceType } from '../../domain/place-type';
import { type Agent, type Team } from '../../domain/agent';
import { isFullyPriced, type ServiceDefinition, teamSizeField } from '../../domain/catalog';
import { CURRENCY } from '../../domain/money';
import { expectedDeposit, paidAmount, paymentStatus, remainingDue } from '../../domain/payment';
import { type Quote } from '../../domain/quote';
import { type Measurement, type QuoteRequest } from '../../domain/quote-request';
import { type Recurrence } from '../../domain/recurrence';
import { type Slot } from '../../domain/schedule';
import { type PriceLine } from '../../domain/simulator';
import {
  answersToProto,
  calculationToProto,
  fieldToProto,
  optionsToProto,
  presentForm,
  selectionsToProto,
  summaryToProto,
} from './form.presenters';

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

/** Position (ADR-034) ; précision inconnue : 0. */
const presentLocation = (location: GeoLocation | null): cleaningV1.GeoLocation | undefined =>
  location
    ? {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracyMeters: location.accuracyMeters ?? 0,
      }
    : undefined;

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

/**
 * Demande ; les noms (back-office) restent vides sans annuaire, par exemple dans l'espace client ;
 * les libellés de prestation et de lieu et la taille du groupe viennent de `labels` (ADR-034).
 */
export function presentRequest(
  request: QuoteRequest | StaffRequest,
  names: NameBook = NO_NAMES,
  labels: RequestLabels = NO_LABELS,
): cleaningV1.QuoteRequest {
  const backoffice = labels.audience === 'backoffice';
  // Agent seul (ADR-037) : aucun montant, y compris le calcul des mesures.
  const withAmounts = !('withAmounts' in request) || request.withAmounts;
  const summaries = labels.summaries.get(request.id);
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
    estimate:
      withAmounts && request.estimate
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
          groupVisitId: text(request.visit.groupVisitId),
        }
      : undefined,
    quote: withAmounts && request.quote ? presentQuote(request.quote) : undefined,
    missionId: text(request.missionId),
    closingReason: text(request.closingReason),
    createdAt: iso(request.createdAt),
    updatedAt: iso(request.updatedAt),
    daysPerWeek: request.daysPerWeek ?? 0,
    customerName: userName(names, request.customerId),
    organizationName: organizationName(names, request.organizationId),
    answers: request.answers ? answersToProto(request.answers) : undefined,
    optionSelections: selectionsToProto(request.optionSelections),
    frequency: text(request.frequency),
    pricingVersion: request.pricingVersion ?? 0,
    calculation: withAmounts && request.calculation ? calculationToProto(request.calculation) : undefined,
    groupId: text(request.groupId),
    placeType: text(request.placeType),
    location: presentLocation(request.location),
    landmark: text(request.landmark),
    geocodingProvider: text(request.geocodingProvider),
    groupSize: request.groupId ? (labels.groupSizes.get(request.groupId) ?? 1) : 1,
    serviceName: labels.serviceNames.get(request.serviceCode) ?? '',
    placeTypeLabel: (request.placeType && labels.placeTypeLabels.get(request.placeType)) || '',
    geocodedAddress: text(request.geocodedAddress),
    // Mesures constatées (ADR-037) : au back-office seulement.
    measurement:
      backoffice && request.measurement
        ? presentMeasurement(request.measurement, names, withAmounts)
        : undefined,
    answerSummary: summaries ? summaryToProto(summaries.answers) : undefined,
    measuredSummary: backoffice && summaries?.measured ? summaryToProto(summaries.measured) : undefined,
  };
}

/** Mesures constatées ; sans leur calcul pour un agent seul dans la liste des visites. */
function presentMeasurement(
  measurement: Measurement,
  names: NameBook,
  withAmounts = true,
): cleaningV1.RequestMeasurement {
  return {
    answers: answersToProto(measurement.answers),
    optionSelections: selectionsToProto(measurement.optionSelections),
    frequency: text(measurement.frequency),
    calculation: withAmounts ? calculationToProto(measurement.calculation) : undefined,
    pricingVersion: measurement.pricingVersion,
    measuredAt: iso(measurement.measuredAt),
    measuredBy: measurement.measuredBy,
    measuredByName: userName(names, measurement.measuredBy),
  };
}

/** Demande sœur d'un groupe, vue du back-office (ADR-034). */
export function presentSibling(
  request: QuoteRequest,
  labels: RequestLabels,
): cleaningV1.GroupedRequestSummary {
  return {
    id: request.id,
    serviceCode: request.serviceCode,
    status: request.status,
    serviceName: labels.serviceNames.get(request.serviceCode) ?? '',
    visitScheduledAt: iso(
      request.visit && request.visit.status !== 'cancelled' ? request.visit.scheduledAt : null,
    ),
    quoteTotal: request.quote ? money(request.quote.total) : undefined,
    missionId: text(request.missionId),
  };
}

/** Groupe de demandes du client (ADR-034). */
export function presentGroup(
  view: QuoteRequestGroupView,
  labels: RequestLabels = NO_LABELS,
  totals: GroupTotals = { quotesTotal: null, remainingDue: null },
): cleaningV1.QuoteRequestGroup {
  return {
    // Totaux du groupe (ADR-035) : absents quand inconnus.
    quotesTotal: optionalMoney(totals.quotesTotal),
    remainingDue: optionalMoney(totals.remainingDue),
    id: view.group.id,
    placeType: view.group.placeType,
    commune: view.group.commune,
    zoneCode: zoneCode(view.group.commune),
    createdAt: iso(view.group.createdAt),
    requests: view.requests.map((request) => presentRequest(request, NO_NAMES, labels)),
  };
}

/** Type de lieu vu du public : ses prestations actives seulement (déjà filtrées). */
export function presentPublicPlaceType(placeType: PlaceType): cleaningV1.PublicPlaceType {
  return {
    code: placeType.code,
    label: placeType.label,
    description: placeType.description,
    icon: placeType.icon,
    displayOrder: placeType.displayOrder,
    serviceCodes: placeType.serviceCodes,
  };
}

/** Type de lieu vu du back-office, avec la cohérence de ses prestations. */
export function presentPlaceType(
  { placeType, health }: PlaceTypeView,
  names: NameBook = NO_NAMES,
): cleaningV1.PlaceType {
  return {
    code: placeType.code,
    label: placeType.label,
    description: placeType.description,
    icon: placeType.icon,
    displayOrder: placeType.displayOrder,
    active: placeType.active,
    serviceCodes: placeType.serviceCodes,
    updatedBy: text(placeType.updatedBy),
    updatedAt: iso(placeType.updatedAt),
    updatedByName: userName(names, placeType.updatedBy),
    unknownServiceCodes: health.unknownServiceCodes,
    inactiveServiceCodes: health.inactiveServiceCodes,
    publiclyVisible: health.publiclyVisible,
    visibilityReason: health.visibilityReason ?? '',
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
      remainingDue: money(remainingDue(payment)),
      depositDue: optionalMoney(expectedDeposit(payment)),
      payments: payment.payments.map((record) => ({
        id: record.id,
        amount: money(record.amount),
        method: record.method,
        reference: text(record.reference),
        recordedBy: record.recordedBy,
        recordedAt: iso(record.recordedAt),
        recordedByName: userName(names, record.recordedBy),
        refundedAt: record.refundedAt ? iso(record.refundedAt) : '',
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
    location: presentLocation(mission.location),
    landmark: text(mission.landmark),
    groupId: text(mission.groupId),
    placeType: text(mission.placeType),
  };
}

const optionalMoney = (amount: number | null) => (amount === null ? undefined : money(amount));

/** Anciennes options (dépréciées) : options actives et leur forfait. */
const legacyOptions = (service: ServiceDefinition): cleaningV1.CatalogOption[] =>
  service.options
    .filter((option) => option.active)
    .map((option) => ({ code: option.code, label: option.label, price: optionalMoney(option.flatPrice) }));

export function presentOffer(service: ServiceDefinition): cleaningV1.ServiceOffer {
  return {
    code: service.code,
    name: service.name,
    description: service.description,
    // Anciens champs (dépréciés, ADR-033), gardés remplis pendant la transition.
    unit: service.unit,
    options: legacyOptions(service),
    priced: isFullyPriced(service),
    minimumPrice: optionalMoney(service.pricing.minimumPrice),
    form: presentForm(service),
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
      // Anciens champs (dépréciés, ADR-033), déduits de la définition.
      unitPrice: optionalMoney(teamSizeField(service)?.pricePerUnit ?? null),
      minimumPrice: optionalMoney(pricing.minimumPrice),
      options: service.options.map((option) => ({
        code: option.code,
        label: option.label,
        price: optionalMoney(option.flatPrice),
      })),
      frequencies: pricing.frequencies.map((frequency) => ({ ...frequency })),
      communeCoefficients: Object.entries(pricing.communeCoefficients).map(([commune, coefficientBp]) => ({
        commune,
        coefficientBp,
      })),
      defaultCoefficientBp: pricing.defaultCoefficientBp,
      teamSize: { ...pricing.teamSize, fieldCode: text(pricing.teamSize.fieldCode) },
      checklist: pricing.checklist.map((item) => ({ ...item, done: false })),
      updatedBy: pricing.updatedBy,
      updatedAt: pricing.version ? iso(pricing.updatedAt) : '',
      updatedByName: userName(names, pricing.updatedBy),
    },
    fields: service.fields.map(fieldToProto),
    options: optionsToProto(service),
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
    locationRetentionMonths: settings.locationRetentionMonths,
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

export function presentZone({ zone, activity }: ZoneView, names: NameBook = NO_NAMES): cleaningV1.Zone {
  return {
    // Activité de la zone (ADR-035).
    openRequests: activity.openRequests,
    activeMissions: activity.activeMissions,
    code: zone.code,
    commune: zone.commune,
    aliases: zone.aliases,
    active: zone.active,
    updatedBy: text(zone.updatedBy),
    updatedAt: iso(zone.updatedAt),
    updatedByName: userName(names, zone.updatedBy),
  };
}

/** Résultat d'une opération de groupe (ADR-035). */
export function presentOutcome(outcome: GroupOutcome): cleaningV1.RequestGroupOutcome {
  return {
    groupId: outcome.groupId,
    affectedRequestIds: outcome.affectedIds,
    skipped: outcome.skippedRequests.map((entry) => ({ ...entry })),
    groupVisitId: text(outcome.groupVisitId),
    missionIds: outcome.missionIds,
  };
}

/**
 * Visite vue d'un agent ou de la supervision (ADR-035) : une entrée par visite commune ou seule ;
 * chaque demande porte les réponses du client et les mesures (ADR-037), sans montant pour un agent.
 */
export function presentVisit(
  entry: VisitView,
  names: NameBook = NO_NAMES,
  labels: RequestLabels = NO_LABELS,
): cleaningV1.VisitSummary {
  const lead = entry.requests[0];
  const visit = lead?.visit;
  return {
    id: entry.id,
    groupVisitId: text(visit?.groupVisitId),
    groupId: text(lead?.groupId),
    status: visit?.status ?? '',
    scheduledAt: iso(visit?.scheduledAt),
    completedAt: iso(visit?.completedAt),
    report: text(visit?.report),
    agentId: visit?.agentId ?? '',
    agentName: userName(names, visit?.agentId),
    customerId: lead?.customerId ?? '',
    customerName: userName(names, lead?.customerId),
    organizationName: organizationName(names, lead?.organizationId),
    commune: lead?.commune ?? '',
    address: lead?.address ?? '',
    location: presentLocation(lead?.location ?? null),
    landmark: text(lead?.landmark),
    geocodedAddress: text(lead?.geocodedAddress),
    placeType: text(lead?.placeType),
    placeTypeLabel: (lead?.placeType && labels.placeTypeLabels.get(lead.placeType)) || '',
    requests: entry.requests.map((request) => presentVisitedRequest(request, names, labels)),
  };
}

function presentVisitedRequest(
  request: StaffRequest,
  names: NameBook,
  labels: RequestLabels,
): cleaningV1.VisitedRequest {
  const { withAmounts } = request;
  const summaries = labels.summaries.get(request.id);
  return {
    requestId: request.id,
    visitId: request.visit?.id ?? '',
    serviceCode: request.serviceCode,
    serviceName: labels.serviceNames.get(request.serviceCode) ?? '',
    status: request.status,
    placeType: text(request.placeType),
    placeTypeLabel: (request.placeType && labels.placeTypeLabels.get(request.placeType)) || '',
    answers: request.answers ? answersToProto(request.answers) : undefined,
    optionSelections: selectionsToProto(request.optionSelections),
    frequency: text(request.frequency),
    pricingVersion: request.pricingVersion ?? 0,
    answerSummary: summaries ? summaryToProto(summaries.answers) : undefined,
    calculation: withAmounts && request.calculation ? calculationToProto(request.calculation) : undefined,
    measurement: request.measurement
      ? presentMeasurement(request.measurement, names, withAmounts)
      : undefined,
    measuredSummary: summaries?.measured ? summaryToProto(summaries.measured) : undefined,
  };
}
