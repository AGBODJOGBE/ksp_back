import {
  type Prisma,
  type Quote as QuoteRow,
  type QuoteRequest as RequestRow,
  type SiteVisit as VisitRow,
} from '../../../prisma/generated';
import { type PremisesType } from '../../domain/catalog';
import { type Quote } from '../../domain/quote';
import {
  type CustomerKind,
  type QuoteRequest,
  type RequestStatus,
  type VisitStatus,
} from '../../domain/quote-request';
import { type Recurrence } from '../../domain/recurrence';
import { type Slot } from '../../domain/schedule';
import { type PriceLine } from '../../domain/simulator';
import { json } from './changes';

/** Traduction entre les lignes PostgreSQL et le modèle du domaine. */
type StoredSlot = { start: string; end: string };

export const slotsToJson = (slots: Slot[]) =>
  json(slots.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })));
export const slotsFromJson = (value: Prisma.JsonValue): Slot[] =>
  (value as StoredSlot[]).map((slot) => ({ start: new Date(slot.start), end: new Date(slot.end) }));
export const recurrenceFromJson = (value: Prisma.JsonValue | null): Recurrence | null =>
  value ? (value as unknown as Recurrence) : null;
export const recurrenceToJson = (value: Recurrence | null) => (value ? json(value) : undefined);

/** Une demande et sa dernière version de devis (la seule en vigueur). */
export const REQUEST_INCLUDE = { visit: true, quotes: { orderBy: { sentAt: 'desc' as const }, take: 1 } };
export type RequestWithRelations = RequestRow & { visit: VisitRow | null; quotes: QuoteRow[] };

function toQuote(row: QuoteRow): Quote {
  return {
    id: row.id,
    lines: row.lines as unknown as PriceLine[],
    subtotal: row.subtotal,
    interventionCount: row.interventionCount,
    total: row.total,
    proposedSlots: slotsFromJson(row.proposedSlots),
    validUntil: row.validUntil,
    depositPercent: row.depositPercent,
    depositAmount: row.depositAmount,
    recurrence: recurrenceFromJson(row.recurrence),
    teamSize: row.teamSize,
    durationMinutes: row.durationMinutes,
    sentAt: row.sentAt,
  };
}

export function toRequest(row: RequestWithRelations): QuoteRequest {
  const quote = row.quotes[0];
  return {
    id: row.id,
    status: row.status as RequestStatus,
    customerId: row.customerId,
    customerKind: row.customerKind as CustomerKind,
    organizationId: row.organizationId,
    serviceCode: row.serviceCode,
    premisesType: row.premisesType as PremisesType,
    quantity: row.quantity,
    options: row.options,
    commune: row.commune,
    address: row.address,
    preferredSlots: slotsFromJson(row.preferredSlots),
    comment: row.comment,
    recurrence: recurrenceFromJson(row.recurrence),
    requestedTeamSize: row.requestedTeamSize,
    daysPerWeek: row.daysPerWeek,
    recommendedTeamSize: row.recommendedTeamSize,
    estimate:
      row.estimateLow !== null && row.estimateHigh !== null
        ? { low: row.estimateLow, high: row.estimateHigh }
        : null,
    visit: row.visit
      ? {
          id: row.visit.id,
          status: row.visit.status as VisitStatus,
          scheduledAt: row.visit.scheduledAt,
          agentId: row.visit.agentId,
          report: row.visit.report,
          completedAt: row.visit.completedAt,
        }
      : null,
    quote: quote ? toQuote(quote) : null,
    missionId: row.missionId,
    closingReason: row.closingReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** Colonnes modifiables d'une demande (hors identifiant, client et clé d'idempotence). */
export function requestColumns(request: QuoteRequest) {
  return {
    status: request.status,
    customerKind: request.customerKind,
    organizationId: request.organizationId,
    serviceCode: request.serviceCode,
    premisesType: request.premisesType,
    quantity: request.quantity,
    options: request.options,
    commune: request.commune,
    address: request.address,
    preferredSlots: slotsToJson(request.preferredSlots),
    comment: request.comment,
    recurrence: recurrenceToJson(request.recurrence),
    requestedTeamSize: request.requestedTeamSize,
    daysPerWeek: request.daysPerWeek,
    recommendedTeamSize: request.recommendedTeamSize,
    estimateLow: request.estimate?.low ?? null,
    estimateHigh: request.estimate?.high ?? null,
    currentQuoteId: request.quote?.id ?? null,
    missionId: request.missionId,
    closingReason: request.closingReason,
    updatedAt: request.updatedAt,
  };
}

export function quoteColumns(requestId: string, quote: Quote) {
  return {
    id: quote.id,
    requestId,
    lines: json(quote.lines),
    subtotal: quote.subtotal,
    interventionCount: quote.interventionCount,
    total: quote.total,
    proposedSlots: slotsToJson(quote.proposedSlots),
    validUntil: quote.validUntil,
    depositPercent: quote.depositPercent,
    depositAmount: quote.depositAmount,
    recurrence: recurrenceToJson(quote.recurrence),
    teamSize: quote.teamSize,
    durationMinutes: quote.durationMinutes,
    sentAt: quote.sentAt,
  };
}
