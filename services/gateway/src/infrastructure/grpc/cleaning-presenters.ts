import { type cleaningV1, type moneyV1 } from '@ksp/contracts';
import { AppError } from '@ksp/platform';

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
  };
}

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
        }
      : null,
    quote: value.quote ? presentQuote(value.quote) : null,
    missionId: orNull(value.missionId),
    closingReason: orNull(value.closingReason),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
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
    status: value.status,
    serviceCode: value.serviceCode,
    commune: value.commune,
    address: value.address,
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
      payments: (payment?.payments ?? []).map((record) => ({
        id: record.id,
        amount: requiredMoney(record.amount),
        method: record.method,
        reference: orNull(record.reference),
        recordedBy: record.recordedBy,
        recordedAt: record.recordedAt,
      })),
    },
    cancellationReason: orNull(value.cancellationReason),
    daysPerWeek: value.daysPerWeek || null,
    suspension: value.suspension
      ? {
          cause: value.suspension.cause,
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
      },
      checklist: (pricing?.checklist ?? []).map((item) => ({ code: item.code, label: item.label })),
      updatedBy: orNull(pricing?.updatedBy),
      updatedAt: orNull(pricing?.updatedAt),
    },
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
    updatedBy: orNull(value.updatedBy),
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

export function presentZone(value: cleaningV1.Zone | undefined) {
  if (!value) throw malformed('zone');
  return {
    code: value.code,
    commune: value.commune,
    active: value.active,
    updatedBy: orNull(value.updatedBy),
    updatedAt: orNull(value.updatedAt),
  };
}
