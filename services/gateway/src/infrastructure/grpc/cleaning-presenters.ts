import { type cleaningV1, type moneyV1 } from '@ksp/contracts';
import { AppError } from '@ksp/platform';
import {
  answersFromProto,
  presentCalculation,
  presentFields,
  presentForm,
  presentOptionDefinitions,
  selectionsFromProto,
} from './cleaning-form-presenters';

/**
 * Traduction des messages ksp.cleaning.v1 vers le JSON du contrat OpenAPI : montants
 * { amount, currency }, message ou chaîne vide → null, entier 0 « non précisé » → null.
 */
/** Réponse de cleaning qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse de cleaning inattendue (${what}).`);

const orNull = (value: string | undefined): string | null => (value ? value : null);

export const money = (value: moneyV1.Money | undefined) =>
  value ? { amount: value.amount, currency: value.currency } : null;
const requiredMoney = (value: moneyV1.Money | undefined) => money(value) ?? { amount: 0, currency: 'XOF' };
export const xof = (amount: number): moneyV1.Money => ({ amount, currency: 'XOF' });

const slot = (value: cleaningV1.TimeSlot | undefined) => ({
  start: value?.start ?? '',
  end: value?.end ?? '',
});
const recurrence = (value: cleaningV1.Recurrence | undefined) =>
  value?.period
    ? { period: value.period, visitsPerPeriod: value.visitsPerPeriod, durationMonths: value.durationMonths }
    : null;
const line = (value: cleaningV1.PriceLine) => ({
  label: value.label,
  quantity: value.quantity,
  unitPrice: requiredMoney(value.unitPrice),
  amount: requiredMoney(value.amount),
});
const range = (value: cleaningV1.PriceRange | undefined) =>
  value ? { low: requiredMoney(value.low), high: requiredMoney(value.high) } : null;
/** Position (ADR-034) ; précision 0 : inconnue. */
const location = (value: cleaningV1.GeoLocation | undefined) =>
  value
    ? { latitude: value.latitude, longitude: value.longitude, accuracyMeters: value.accuracyMeters || null }
    : null;
const option = (value: cleaningV1.CatalogOption) => ({
  code: value.code,
  label: value.label,
  price: money(value.price),
});

export function presentOffer(value: cleaningV1.ServiceOffer) {
  return {
    code: value.code,
    name: value.name,
    description: value.description,
    unit: value.unit,
    options: value.options.map(option),
    priced: value.priced,
    minimumPrice: money(value.minimumPrice),
    form: presentForm(value.form),
  };
}

const malformedCalculation = () => {
  throw malformed('détail du calcul');
};

export function presentSimulation(value: cleaningV1.SimulateResponse) {
  return {
    serviceCode: value.serviceCode,
    priced: value.priced,
    estimate: range(value.estimate),
    computedPrice: money(value.computedPrice),
    breakdown: value.breakdown.map(line),
    minimumApplied: value.minimumApplied,
    communeCoefficientBp: value.communeCoefficientBp,
    recommendedTeamSize: value.recommendedTeamSize,
    notice: value.notice,
    covered: value.covered,
    reason: orNull(value.reason),
    calculation: presentCalculation(value.calculation) ?? malformedCalculation(),
    // Faux sans commune (ADR-034) : coefficient neutre, prix indicatif.
    communeApplied: value.communeApplied,
  };
}

/** Estimation de plusieurs prestations d'un lieu (ADR-034). */
export function presentEstimate(value: cleaningV1.EstimateResponse) {
  return {
    placeType: value.placeType,
    commune: orNull(value.commune),
    communeApplied: value.communeApplied,
    covered: value.covered,
    status: value.status,
    total: value.total ? value.total.amount : null,
    currency: 'XOF',
    notice: value.notice,
    items: value.items.map((item) => {
      const calculation = presentCalculation(item.calculation) ?? malformedCalculation();
      return {
        serviceCode: item.serviceCode,
        serviceName: item.serviceName,
        priced: item.priced,
        reason: orNull(item.reason),
        notice: item.notice,
        estimate: calculation.estimate,
        computedPrice: calculation.computedPrice,
        recommendedTeamSize: calculation.recommendedTeamSize,
        missingPrices: calculation.missingPrices,
        calculation,
      };
    }),
  };
}

export function presentPublicPlaceType(value: cleaningV1.PublicPlaceType) {
  return {
    code: value.code,
    label: value.label,
    description: orNull(value.description),
    icon: value.icon,
    displayOrder: value.displayOrder,
    serviceCodes: value.serviceCodes,
  };
}

export function presentPlaceCatalog(value: cleaningV1.GetPlaceCatalogResponse) {
  return {
    placeTypes: value.placeTypes.map(presentPublicPlaceType),
    services: value.services.map(presentOffer),
  };
}

export function presentPlaceType(value: cleaningV1.PlaceType | undefined) {
  if (!value) throw malformed('type de lieu');
  return {
    code: value.code,
    label: value.label,
    description: orNull(value.description),
    icon: value.icon,
    displayOrder: value.displayOrder,
    active: value.active,
    serviceCodes: value.serviceCodes,
    unknownServiceCodes: value.unknownServiceCodes,
    inactiveServiceCodes: value.inactiveServiceCodes,
    publiclyVisible: value.publiclyVisible,
    visibilityReason: orNull(value.visibilityReason),
    updatedBy: orNull(value.updatedBy),
    updatedByName: orNull(value.updatedByName),
    updatedAt: orNull(value.updatedAt),
  };
}

export function presentLocationResolution(value: cleaningV1.ResolveLocationResponse) {
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    commune: orNull(value.commune),
    zoneCode: orNull(value.zoneCode),
    served: value.served,
    displayAddress: orNull(value.displayAddress),
    provider: orNull(value.provider),
  };
}

export function presentGroup(value: cleaningV1.QuoteRequestGroup | undefined) {
  if (!value) throw malformed('groupe de demandes');
  return {
    groupId: value.id,
    placeType: value.placeType,
    commune: value.commune,
    zoneCode: value.zoneCode,
    createdAt: value.createdAt,
    items: value.requests.map(presentRequest),
    // Totaux du groupe (ADR-035) : null quand inconnus ; pas de paiement groupé.
    quotesTotal: money(value.quotesTotal),
    remainingDue: money(value.remainingDue),
  };
}

/** Demande sœur d'un groupe (back-office, ADR-034). */
export function presentSibling(value: cleaningV1.GroupedRequestSummary) {
  return {
    id: value.id,
    serviceCode: value.serviceCode,
    serviceName: orNull(value.serviceName),
    status: value.status,
    visitScheduledAt: orNull(value.visitScheduledAt),
    quoteTotal: money(value.quoteTotal),
    missionId: orNull(value.missionId),
  };
}

function presentQuote(value: cleaningV1.Quote) {
  return {
    id: value.id,
    lines: value.lines.map(line),
    subtotal: requiredMoney(value.subtotal),
    interventionCount: value.interventionCount,
    total: requiredMoney(value.total),
    proposedSlots: value.proposedSlots.map(slot),
    validUntil: value.validUntil,
    depositPercent: value.depositPercent,
    depositAmount: requiredMoney(value.depositAmount),
    recurrence: recurrence(value.recurrence),
    teamSize: value.teamSize,
    durationMinutes: value.durationMinutes,
    sentAt: value.sentAt,
  };
}

export function presentRequest(value: cleaningV1.QuoteRequest | undefined) {
  if (!value) throw malformed('demande');
  const visit = value.visit;
  return {
    id: value.id,
    status: value.status,
    customerId: value.customerId,
    customerKind: value.customerKind,
    organizationId: orNull(value.organizationId),
    serviceCode: value.serviceCode,
    premisesType: value.premisesType,
    quantity: value.quantity,
    options: value.options,
    commune: value.commune,
    address: value.address,
    preferredSlots: value.preferredSlots.map(slot),
    comment: orNull(value.comment),
    recurrence: recurrence(value.recurrence),
    requestedTeamSize: value.requestedTeamSize || null,
    daysPerWeek: value.daysPerWeek || null,
    recommendedTeamSize: value.recommendedTeamSize,
    estimate: range(value.estimate),
    visit: visit
      ? {
          id: visit.id,
          status: visit.status,
          scheduledAt: visit.scheduledAt,
          agentId: visit.agentId,
          report: orNull(visit.report),
          completedAt: orNull(visit.completedAt),
          agentName: orNull(visit.agentName),
          groupVisitId: orNull(visit.groupVisitId),
        }
      : null,
    quote: value.quote ? presentQuote(value.quote) : null,
    missionId: orNull(value.missionId),
    closingReason: orNull(value.closingReason),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    // Back-office (ADR-029) : null dans l'espace client, pour un compte sans nom, ou identity indisponible.
    customerName: orNull(value.customerName),
    organizationName: orNull(value.organizationName),
    // Formulaire (ADR-033) : null pour une demande antérieure.
    answers: value.answers ? answersFromProto(value.answers) : null,
    selectedOptions: selectionsFromProto(value.optionSelections ?? []),
    frequency: orNull(value.frequency),
    pricingVersion: value.pricingVersion || null,
    calculation: presentCalculation(value.calculation),
    // Parcours par lieu (ADR-034) : null pour une demande sans lieu ni position.
    groupId: orNull(value.groupId),
    groupSize: value.groupSize || 1,
    placeType: orNull(value.placeType),
    placeTypeLabel: orNull(value.placeTypeLabel),
    serviceName: orNull(value.serviceName),
    location: location(value.location),
    landmark: orNull(value.landmark),
    geocodingProvider: orNull(value.geocodingProvider),
    geocodedAddress: orNull(value.geocodedAddress),
  };
}

export function presentMission(value: cleaningV1.Mission | undefined) {
  if (!value) throw malformed('mission');
  const payment = value.payment;
  return {
    id: value.id,
    requestId: value.requestId,
    quoteId: value.quoteId,
    customerId: value.customerId,
    // Particulier ou entreprise : une mission d'entreprise se règle par sa facture (pas de paiement manuel).
    customerKind: value.customerKind === 'business' ? 'business' : 'individual',
    organizationId: orNull(value.organizationId),
    customerName: orNull(value.customerName),
    organizationName: orNull(value.organizationName),
    status: value.status,
    serviceCode: value.serviceCode,
    commune: value.commune,
    address: value.address,
    // Position et repère copiés de la demande (ADR-034), pour aller sur place.
    location: location(value.location),
    landmark: orNull(value.landmark),
    groupId: orNull(value.groupId),
    placeType: orNull(value.placeType),
    chosenSlot: slot(value.chosenSlot),
    recurrence: recurrence(value.recurrence),
    plannedInterventions: value.plannedInterventions,
    completedInterventions: value.completedInterventions,
    interventions: value.interventions.map((i) => ({
      id: i.id,
      status: i.status,
      scheduledStart: i.scheduledStart,
      durationMinutes: i.durationMinutes,
      agents: i.agents.map((agent) => ({ agentId: agent.agentId, displayName: agent.displayName })),
      checklist: i.checklist.map((item) => ({ code: item.code, label: item.label, done: item.done })),
      incidentNote: orNull(i.incidentNote),
      beforePhotoFileIds: i.beforePhotoFileIds,
      afterPhotoFileIds: i.afterPhotoFileIds,
      startedAt: orNull(i.startedAt),
      completedAt: orNull(i.completedAt),
      cancellationCause: orNull(i.cancellationCause),
    })),
    payment: {
      plan: {
        option: payment?.plan?.option ?? '',
        timing: payment?.plan?.timing ?? '',
        method: payment?.plan?.method ?? '',
      },
      status: payment?.status ?? 'due',
      total: requiredMoney(payment?.total),
      depositPercent: payment?.depositPercent ?? 0,
      depositAmount: requiredMoney(payment?.depositAmount),
      paid: requiredMoney(payment?.paid),
      // Calculés par cleaning ; un service cleaning antérieur ne les envoie pas : reste dû déduit du total.
      remainingDue:
        money(payment?.remainingDue) ??
        xof(Math.max(0, (payment?.total?.amount ?? 0) - (payment?.paid?.amount ?? 0))),
      depositDue: money(payment?.depositDue),
      payments: (payment?.payments ?? []).map((record) => ({
        id: record.id,
        amount: requiredMoney(record.amount),
        method: record.method,
        reference: orNull(record.reference),
        recordedBy: record.recordedBy,
        recordedByName: orNull(record.recordedByName),
        recordedAt: record.recordedAt,
      })),
    },
    cancellationReason: orNull(value.cancellationReason),
    daysPerWeek: value.daysPerWeek || null,
    suspension: value.suspension
      ? {
          cause: value.suspension.cause,
          // Service cleaning antérieur à l'ADR-030 : une seule cause, sans la liste.
          causes: value.suspension.causes.length ? value.suspension.causes : [value.suspension.cause],
          since: value.suspension.since,
          unpaidCount: value.suspension.unpaidCount,
        }
      : null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function presentDefinition(value: cleaningV1.ServiceDefinition | undefined) {
  if (!value) throw malformed('prestation');
  const pricing = value.pricing;
  return {
    code: value.code,
    name: value.name,
    description: value.description,
    unit: value.unit,
    active: value.active,
    pricing: {
      version: pricing?.version ?? 0,
      unitPrice: money(pricing?.unitPrice),
      minimumPrice: money(pricing?.minimumPrice),
      options: (pricing?.options ?? []).map(option),
      communeCoefficients: (pricing?.communeCoefficients ?? []).map((c) => ({
        commune: c.commune,
        coefficientBp: c.coefficientBp,
      })),
      defaultCoefficientBp: pricing?.defaultCoefficientBp ?? 10000,
      teamSize: {
        unitsPerAgent: pricing?.teamSize?.unitsPerAgent ?? 1,
        minAgents: pricing?.teamSize?.minAgents ?? 1,
        maxAgents: pricing?.teamSize?.maxAgents ?? 1,
        fieldCode: orNull(pricing?.teamSize?.fieldCode),
      },
      frequencies: (pricing?.frequencies ?? []).map(({ code, label, coefficientBp, active }) => ({
        code,
        label,
        coefficientBp,
        active,
      })),
      checklist: (pricing?.checklist ?? []).map((item) => ({ code: item.code, label: item.label })),
      updatedBy: orNull(pricing?.updatedBy),
      updatedByName: orNull(pricing?.updatedByName),
      updatedAt: orNull(pricing?.updatedAt),
    },
    fields: presentFields(value.fields ?? []),
    options: presentOptionDefinitions(value.options ?? []),
  };
}

export function presentSettings(value: cleaningV1.Settings | undefined) {
  if (!value) throw malformed('réglages');
  return {
    quoteValidityDays: value.quoteValidityDays,
    minimumLeadHours: value.minimumLeadHours,
    freeCancellationHours: value.freeCancellationHours,
    visitThresholdSquareMeters: value.visitThresholdSquareMeters,
    maxOpenRequests: value.maxOpenRequests,
    depositPercent: value.depositPercent,
    businessWarningUnpaidInvoices: value.businessWarningUnpaidInvoices,
    businessSuspensionUnpaidInvoices: value.businessSuspensionUnpaidInvoices,
    individualSuspensionUnpaidInterventions: value.individualSuspensionUnpaidInterventions,
    individualPaymentGraceHours: value.individualPaymentGraceHours,
    locationRetentionMonths: value.locationRetentionMonths || 12,
    updatedBy: orNull(value.updatedBy),
    updatedByName: orNull(value.updatedByName),
    updatedAt: orNull(value.updatedAt),
  };
}

export function presentAgent(value: cleaningV1.Agent | undefined) {
  if (!value) throw malformed('agent');
  return {
    agentId: value.agentId,
    displayName: value.displayName,
    active: value.active,
    unavailabilities: value.unavailabilities.map((u) => ({
      id: u.id,
      start: u.start,
      end: u.end,
      reason: orNull(u.reason),
    })),
  };
}

export function presentTeam(value: cleaningV1.Team | undefined) {
  if (!value) throw malformed('équipe');
  return {
    id: value.id,
    name: value.name,
    members: value.members.map((m) => ({ agentId: m.agentId, displayName: m.displayName })),
  };
}

export function presentServedZone(value: cleaningV1.ServedZone) {
  return { code: value.code, commune: value.commune };
}

export function presentZone(value: cleaningV1.Zone | undefined) {
  if (!value) throw malformed('zone');
  return {
    code: value.code,
    commune: value.commune,
    aliases: value.aliases ?? [],
    active: value.active,
    // Activité de la zone (ADR-035).
    openRequests: value.openRequests ?? 0,
    activeMissions: value.activeMissions ?? 0,
    updatedBy: orNull(value.updatedBy),
    updatedByName: orNull(value.updatedByName),
    updatedAt: orNull(value.updatedAt),
  };
}

/** Résultat d'une opération de groupe (ADR-035). */
export function presentOutcome(value: cleaningV1.RequestGroupOutcome | undefined) {
  if (!value) throw malformed('opération de groupe');
  return {
    groupId: value.groupId,
    affectedRequestIds: value.affectedRequestIds,
    skipped: value.skipped.map((entry) => ({
      requestId: entry.requestId,
      status: entry.status,
      reason: entry.reason,
    })),
    groupVisitId: orNull(value.groupVisitId),
    missionIds: value.missionIds,
  };
}

/** Visite d'un agent ou de la supervision (ADR-035) : position nulle quand elle est masquée. */
export function presentVisit(value: cleaningV1.VisitSummary) {
  return {
    id: value.id,
    groupVisitId: orNull(value.groupVisitId),
    groupId: orNull(value.groupId),
    status: value.status,
    scheduledAt: value.scheduledAt,
    completedAt: orNull(value.completedAt),
    report: orNull(value.report),
    agentId: value.agentId,
    agentName: orNull(value.agentName),
    customerId: value.customerId,
    customerName: orNull(value.customerName),
    organizationName: orNull(value.organizationName),
    commune: value.commune,
    address: orNull(value.address),
    location: location(value.location),
    landmark: orNull(value.landmark),
    geocodedAddress: orNull(value.geocodedAddress),
    placeType: orNull(value.placeType),
    placeTypeLabel: orNull(value.placeTypeLabel),
    requests: value.requests.map((request) => ({
      requestId: request.requestId,
      visitId: request.visitId,
      serviceCode: request.serviceCode,
      serviceName: orNull(request.serviceName),
      status: request.status,
    })),
  };
}
