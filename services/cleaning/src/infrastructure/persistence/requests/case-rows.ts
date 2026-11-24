import { type Prisma } from '../../../../prisma/generated';
import {
  type CaseRecord,
  type DeclaredValues,
  type QuoteRecord,
  type RequestRecord,
  type RevisionRecord,
  type VisitRecord,
} from '../../../application/requests/requests.ports';
import { type VisitFee } from '../../../domain/requests/visit-fee';
import {
  type AdjustmentInput,
  type PaymentTerms,
  type PricedLine,
  type QuoteAdjustment,
} from '../../../domain/quotes/quote';
import { type SchedulePlan } from '../../../domain/schedule-plan/plan';
import { type ValueReason } from '../../../domain/visits/observation';
import { json } from '../changes';

/**
 * Lignes Prisma du dossier ↔ enregistrements de l'application. Ce que le schéma ne porte pas en
 * colonne est gardé en JSON :
 * - devis, colonne `lines` : { lines, adjustments, basePrice, deductibleVisitFee, retainedRevision,
 *   paymentTerms, termsVersion, validityDays } ; dates des séances dans `scheduled_dates` (ISO) ;
 * - révision retenue, colonne `values` : { values, cleaningTypeIds, sessionPrice }.
 */
export const caseInclude = {
  items: { include: { offer: { select: { cleaningTypeId: true } } } },
  visitFees: true,
  visits: true,
  retainedValues: true,
  quotes: true,
  reactivations: true,
  programs: { where: { renewalOfProgramId: null }, select: { id: true, number: true, status: true } },
} satisfies Prisma.CleaningRequestInclude;

export type CaseRow = Prisma.CleaningRequestGetPayload<{ include: typeof caseInclude }>;

interface QuoteBody {
  lines: PricedLine[];
  adjustments: QuoteAdjustment[];
  basePrice: number;
  deductibleVisitFee: number;
  retainedRevision: number;
  paymentTerms: PaymentTerms;
  termsVersion: string;
  validityDays: number | null;
}

interface RevisionBody {
  values: DeclaredValues;
  cleaningTypeIds: string[];
  sessionPrice: number;
}

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

function requestOf(row: CaseRow): RequestRecord {
  return {
    id: row.id,
    number: row.number,
    owner: { kind: row.ownerKind, id: row.ownerId },
    submittedBy: row.submittedBy,
    placeId: row.placeId,
    placeTypeId: row.placeTypeId,
    communeKey: row.communeKey,
    gpsEncrypted: row.gpsEncrypted,
    landmarkEncrypted: row.landmarkEncrypted,
    addressEncrypted: row.addressEncrypted,
    readableAddressEncrypted: row.readableAddressEncrypted,
    communeBoundariesVersion: row.communeBoundariesVersion,
    locationErasedAt: row.locationErasedAt,
    status: row.status,
    declaredValues: row.declaredValues as DeclaredValues,
    declaredRows: row.declaredRows as unknown as RequestRecord['declaredRows'],
    cleaningTypeIds: row.items.map((item) => item.offer.cleaningTypeId),
    items: row.items.map((item) => ({
      offerId: item.offerId,
      cleaningTypeId: item.offer.cleaningTypeId,
      tariffVersionId: item.tariffVersionId,
    })),
    schedulePlan: row.schedulePlan as unknown as SchedulePlan,
    visitSlots: (row.visitSlots as { start: string; end: string }[]).map((slot) => ({
      start: new Date(slot.start),
      end: new Date(slot.end),
    })),
    pricingSnapshot: row.pricingSnapshot,
    estimatedSessionPrice: row.estimatedSessionPrice,
    description: row.description,
    comment: row.comment,
    photoFileIds: row.photoFileIds,
    closingReason: row.closingReason,
    closingReasonCode: row.closingReasonCode,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

function feeOf(row: CaseRow['visitFees'][number]): VisitFee {
  return {
    id: row.id,
    rank: row.rank,
    amount: row.amount,
    status: row.status,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
    refundedAt: row.refundedAt,
  };
}

function visitOf(row: CaseRow['visits'][number]): VisitRecord {
  return {
    id: row.id,
    attempt: row.attempt,
    visitFeeId: row.visitFeeId,
    status: row.status,
    scheduledStart: row.scheduledStart,
    durationMinutes: row.durationMinutes,
    arrivedAt: row.arrivedAt,
    completedAt: row.completedAt,
    missedAt: row.missedAt,
    missedPhotoFileId: row.missedPhotoFileId,
    cancelledAt: row.cancelledAt,
    cancelCause: row.cancelCause,
    closedBy: row.closedBy,
    closedReason: row.closedReason,
    observedValues: (row.observedValues as DeclaredValues | null) ?? null,
    observationNote: row.observationNote,
    observedBy: row.observedBy,
    observedAt: row.observedAt,
    photoFileIds: row.photoFileIds,
    arrivalGpsEncrypted: row.arrivalGpsEncrypted,
    arrivalDistanceM: row.arrivalDistanceM,
    changeReason: row.changeReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function revisionOf(row: CaseRow['retainedValues'][number]): RevisionRecord {
  const body = row.values as unknown as RevisionBody;
  return {
    id: row.id,
    revision: row.revision,
    reason: row.reason,
    visitId: row.visitId,
    values: body.values,
    cleaningTypeIds: body.cleaningTypeIds,
    sessionPrice: body.sessionPrice,
    reasons: row.reasons as unknown as ValueReason[],
    pricingSnapshot: row.pricingSnapshot,
    diff: row.diff as unknown[],
    authorId: row.authorId,
    lockedAt: row.lockedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function quoteOf(row: CaseRow['quotes'][number]): QuoteRecord {
  const body = row.lines as unknown as QuoteBody;
  const decline = row.declineReason as { code: string | null; comment: string | null } | null;
  return {
    id: row.id,
    requestId: row.requestId,
    version: row.version,
    status: row.status,
    retainedRevision: body.retainedRevision,
    lines: body.lines,
    basePrice: body.basePrice,
    adjustments: body.adjustments,
    sessionPrice: row.sessionPrice,
    sessionStarts: row.scheduledDates.map((value) => new Date(value)),
    sessionsCount: row.sessionsCount,
    total: row.total,
    deductibleVisitFee: body.deductibleVisitFee,
    visitFeeDeduction: row.visitFeeDeduction,
    teamSize: row.teamSize,
    durationMinutes: row.durationMinutes,
    paymentTerms: body.paymentTerms,
    termsVersion: body.termsVersion,
    validUntil: row.validUntil,
    sentAt: row.sentAt,
    expiryRemindedAt: row.expiryRemindedAt,
    respondedAt: row.respondedAt,
    respondedBy: row.respondedBy,
    declineReasonCode: decline?.code ?? null,
    declineComment: decline?.comment ?? null,
    acceptedStartDate: day(row.acceptedStartDate),
    withdrawnAt: row.withdrawnAt,
    withdrawnBy: row.withdrawnBy,
    withdrawalReason: row.withdrawalReason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    schedulePlan: row.schedulePlan as unknown as SchedulePlan,
    sentBy: row.sentBy,
    validityDays: body.validityDays,
  };
}

export function caseOf(row: CaseRow): CaseRecord {
  const program = row.programs[0] ?? null;
  return {
    request: requestOf(row),
    fees: row.visitFees.map(feeOf).sort((a, b) => a.rank - b.rank),
    visits: row.visits.map(visitOf).sort((a, b) => a.attempt - b.attempt),
    revisions: row.retainedValues.map(revisionOf).sort((a, b) => a.revision - b.revision),
    quotes: row.quotes.map(quoteOf).sort((a, b) => a.version - b.version),
    reactivations: row.reactivations
      .map((item) => ({
        id: item.id,
        status: item.status,
        requestedAt: item.requestedAt,
        requestedBy: item.requestedBy,
        decidedAt: item.decidedAt,
        decidedBy: item.decidedBy,
        reason: item.reason,
      }))
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime()),
    programId: program?.id ?? null,
    programNumber: program?.number ?? null,
    programStatus: program?.status ?? null,
  };
}

// --- Écriture -----------------------------------------------------------------------------------

export function requestData(request: RequestRecord) {
  return {
    ownerKind: request.owner.kind,
    ownerId: request.owner.id,
    submittedBy: request.submittedBy,
    placeId: request.placeId,
    placeTypeId: request.placeTypeId,
    communeKey: request.communeKey,
    gpsEncrypted: request.gpsEncrypted,
    landmarkEncrypted: request.landmarkEncrypted,
    addressEncrypted: request.addressEncrypted,
    readableAddressEncrypted: request.readableAddressEncrypted,
    communeBoundariesVersion: request.communeBoundariesVersion,
    locationErasedAt: request.locationErasedAt,
    status: request.status,
    declaredValues: json(request.declaredValues),
    declaredRows: json(request.declaredRows),
    schedulePlan: json(request.schedulePlan),
    visitSlots: json(
      request.visitSlots.map((slot) => ({ start: slot.start.toISOString(), end: slot.end.toISOString() })),
    ),
    pricingSnapshot: request.pricingSnapshot === null ? undefined : json(request.pricingSnapshot),
    estimatedSessionPrice: request.estimatedSessionPrice,
    description: request.description,
    comment: request.comment,
    photoFileIds: request.photoFileIds,
    closingReason: request.closingReason,
    closingReasonCode: request.closingReasonCode,
    closedAt: request.closedAt,
    updatedAt: request.updatedAt,
  };
}

export function feeData(fee: VisitFee) {
  return {
    rank: fee.rank,
    amount: fee.amount,
    status: fee.status,
    dueAt: fee.dueAt,
    paidAt: fee.paidAt,
    refundedAt: fee.refundedAt,
  };
}

export function visitData(visit: VisitRecord) {
  return {
    attempt: visit.attempt,
    visitFeeId: visit.visitFeeId,
    status: visit.status,
    scheduledStart: visit.scheduledStart,
    scheduledEnd: new Date(visit.scheduledStart.getTime() + visit.durationMinutes * 60_000),
    durationMinutes: visit.durationMinutes,
    arrivedAt: visit.arrivedAt,
    arrivalGpsEncrypted: visit.arrivalGpsEncrypted,
    arrivalDistanceM: visit.arrivalDistanceM,
    observedValues: visit.observedValues === null ? undefined : json(visit.observedValues),
    observationNote: visit.observationNote,
    observedBy: visit.observedBy,
    observedAt: visit.observedAt,
    photoFileIds: visit.photoFileIds,
    missedPhotoFileId: visit.missedPhotoFileId,
    missedAt: visit.missedAt,
    completedAt: visit.completedAt,
    cancelledAt: visit.cancelledAt,
    cancelCause: visit.cancelCause,
    changeReason: visit.changeReason,
    closedByStaff: visit.closedBy !== null,
    closedBy: visit.closedBy,
    closedReason: visit.closedReason,
  };
}

export function revisionData(revision: RevisionRecord, visitIds: ReadonlySet<string>) {
  const body: RevisionBody = {
    values: revision.values as DeclaredValues,
    cleaningTypeIds: [...revision.cleaningTypeIds],
    sessionPrice: revision.sessionPrice,
  };
  return {
    revision: revision.revision,
    reason: revision.reason,
    visitId: revision.visitId && visitIds.has(revision.visitId) ? revision.visitId : null,
    values: json(body),
    pricingSnapshot: json(revision.pricingSnapshot ?? {}),
    diff: json(revision.diff),
    reasons: json(revision.reasons),
    authorId: revision.authorId,
    lockedAt: revision.lockedAt,
    updatedAt: revision.updatedAt,
  };
}

export function quoteData(quote: QuoteRecord, retainedValuesId: string | null) {
  const body: QuoteBody = {
    lines: quote.lines,
    adjustments: quote.adjustments,
    basePrice: quote.basePrice,
    deductibleVisitFee: quote.deductibleVisitFee,
    retainedRevision: quote.retainedRevision,
    paymentTerms: quote.paymentTerms,
    termsVersion: quote.termsVersion,
    validityDays: quote.validityDays,
  };
  const manual = quote.adjustments.reduce((sum, item) => sum + item.amount, 0);
  return {
    version: quote.version,
    retainedValuesId,
    status: quote.status,
    lines: json(body),
    sessionPrice: quote.sessionPrice,
    sessionsCount: quote.sessionsCount,
    total: quote.total,
    visitFeeDeduction: quote.visitFeeDeduction,
    teamSize: quote.teamSize,
    durationMinutes: quote.durationMinutes,
    schedulePlan: json(quote.schedulePlan),
    scheduledDates: quote.sessionStarts.map((start) => start.toISOString()),
    manualAdjustment: quote.adjustments.length ? manual : null,
    manualAdjustmentReason: quote.adjustments.length
      ? quote.adjustments.map((item: AdjustmentInput) => item.reason).join(' ; ')
      : null,
    adjustmentApprovedBy: quote.adjustments.find((item) => item.approvedBy)?.approvedBy ?? null,
    validUntil: quote.validUntil,
    expiryRemindedAt: quote.expiryRemindedAt,
    sentAt: quote.sentAt,
    sentBy: quote.sentBy,
    respondedAt: quote.respondedAt,
    respondedBy: quote.respondedBy,
    declineReason:
      quote.status === 'declined'
        ? json({ code: quote.declineReasonCode, comment: quote.declineComment })
        : undefined,
    acceptedStartDate: quote.acceptedStartDate ? new Date(`${quote.acceptedStartDate}T00:00:00Z`) : null,
    withdrawnAt: quote.withdrawnAt,
    withdrawnBy: quote.withdrawnBy,
    withdrawalReason: quote.withdrawalReason,
  };
}
