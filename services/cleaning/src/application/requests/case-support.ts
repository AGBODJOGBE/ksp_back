import { type CaseVisit } from '../../domain/requests/request-lifecycle';
import {
  effectiveRequestStatus,
  type RequestStatus,
  type RequestTimeline,
} from '../../domain/requests/request-status';
import { type VisitFee } from '../../domain/requests/visit-fee';
import { effectiveQuoteStatus } from '../../domain/quotes/quote';
import { ConcurrentUpdateError } from '../agents/agent.ports';
import { type CleaningDeps } from '../deps';
import { type AuditEntry, DuplicateKeyError } from '../ports';
import { cleaningErrors } from '../shared/errors';
import { requireUuid } from '../shared/input';
import { caseErrors, translated } from './case-errors';
import { type Customer, ownedBy } from './customer';
import {
  type CaseRecord,
  type CaseWrites,
  type QuoteRecord,
  type RequestRecord,
  type RevisionRecord,
  type VisitRecord,
} from './requests.ports';

/** Lecture et écriture d'un dossier par les cas d'usage du lot C. */

export const money = (amount: number) => ({ amount, currency: 'XOF' as const });
export const iso = (date: Date) => date.toISOString();

/** Devis envoyé en cours (un seul à la fois, index partiel) ; null sinon. */
export function sentQuote(record: CaseRecord): QuoteRecord | null {
  return record.quotes.find((quote) => quote.status === 'sent') ?? null;
}

export function pendingFee(record: CaseRecord): VisitFee | null {
  return record.fees.find((fee) => fee.status === 'awaiting_payment') ?? null;
}

export function latestFee(record: CaseRecord): VisitFee | null {
  return [...record.fees].sort((a, b) => b.rank - a.rank)[0] ?? null;
}

/** Ce que le statut lu doit savoir de l'heure (RV-14). */
export function timelineOf(record: CaseRecord): RequestTimeline {
  return {
    status: record.request.status,
    sentQuoteValidUntil: sentQuote(record)?.validUntil ?? null,
    pendingVisitFeeDueAt: pendingFee(record)?.dueAt ?? null,
  };
}

export function effectiveStatus(record: CaseRecord, now: Date): RequestStatus {
  return effectiveRequestStatus(timelineOf(record), now);
}

/** Visite la plus récente (rang le plus élevé) ; null avant la première. */
export function currentVisit(record: CaseRecord): VisitRecord | null {
  return [...record.visits].sort((a, b) => b.attempt - a.attempt)[0] ?? null;
}

export function liveVisit(record: CaseRecord): VisitRecord | null {
  return (
    record.visits.find((visit) => visit.status === 'scheduled' || visit.status === 'in_progress') ?? null
  );
}

export function caseVisits(record: CaseRecord): CaseVisit[] {
  return record.visits.map((visit) => ({
    visitFeeId: visit.visitFeeId,
    status: visit.status,
    scheduledStart: visit.scheduledStart,
  }));
}

/** Révision ouverte, sinon la plus récente ; null avant le premier enregistrement du retenu. */
export function latestRevision(record: CaseRecord): RevisionRecord | null {
  return (
    record.revisions.find((revision) => revision.lockedAt === null) ??
    [...record.revisions].sort((a, b) => b.revision - a.revision)[0] ??
    null
  );
}

export function quoteById(record: CaseRecord, quoteId: string): QuoteRecord {
  const quote = record.quotes.find((item) => item.id === quoteId);
  if (!quote) throw caseErrors.quoteNotFound();
  return quote;
}

export function effectiveQuote(quote: QuoteRecord, now: Date): QuoteRecord {
  return { ...quote, status: effectiveQuoteStatus(quote, now) };
}

/** Client titulaire du dossier, sinon introuvable (R-CP-04). */
export async function ownedCase(
  deps: CleaningDeps,
  customer: Customer,
  requestId: string,
): Promise<CaseRecord> {
  const record = await deps.cases.findCase(requireUuid(requestId, 'requestId'));
  if (!record || !ownedBy(customer, record.request.owner)) throw caseErrors.requestNotFound();
  return record;
}

export async function ownedCaseByQuote(
  deps: CleaningDeps,
  customer: Customer,
  quoteId: string,
): Promise<{ record: CaseRecord; quote: QuoteRecord }> {
  const id = requireUuid(quoteId, 'quoteId');
  const record = await deps.cases.findCaseByQuote(id);
  if (!record || !ownedBy(customer, record.request.owner)) throw caseErrors.quoteNotFound();
  const quote = quoteById(record, id);
  // Le client ne voit jamais un brouillon (R-DV-01).
  if (quote.status === 'draft') throw caseErrors.quoteNotFound();
  return { record, quote };
}

export async function staffCase(deps: CleaningDeps, requestId: string): Promise<CaseRecord> {
  const record = await deps.cases.findCase(requireUuid(requestId, 'requestId'));
  if (!record) throw caseErrors.requestNotFound();
  return record;
}

export async function caseOfVisit(
  deps: CleaningDeps,
  visitId: string,
): Promise<{ record: CaseRecord; visit: VisitRecord }> {
  const id = requireUuid(visitId, 'visitId');
  const record = await deps.cases.findCaseByVisit(id);
  const visit = record?.visits.find((item) => item.id === id);
  if (!record || !visit) throw caseErrors.visitNotFound();
  return { record, visit };
}

/** Écrit le dossier ; écriture concurrente : CLEANING_CONCURRENT_UPDATE. */
export async function saveCase(
  deps: CleaningDeps,
  record: CaseRecord,
  expectedVersion: number,
  writes: CaseWrites,
): Promise<CaseRecord> {
  try {
    await deps.cases.saveCase(record, expectedVersion, writes);
  } catch (error) {
    if (error instanceof ConcurrentUpdateError) throw cleaningErrors.concurrentUpdate();
    if (error instanceof DuplicateKeyError && error.key === 'concurrent')
      throw cleaningErrors.concurrentUpdate();
    throw translated(error);
  }
  return { ...record, request: { ...record.request, version: expectedVersion + 1 } };
}

/** Champs communs des événements d'un dossier : jamais d'adresse, de position ni de texte libre. */
export function caseParty(request: RequestRecord) {
  return {
    requestId: request.id,
    requestNumber: request.number,
    customerId: request.submittedBy,
    organizationId: request.owner.kind === 'organization' ? request.owner.id : null,
  };
}

/** Trace du journal (RV-12) : identifiants et montants seulement. */
export function audit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  at: Date,
  details?: Record<string, unknown>,
): AuditEntry {
  return { actorId, action, entityType, entityId, at, ...(details ? { details } : {}) };
}

/** Libellés du catalogue pour les événements (noms des éléments désactivés compris, RV-46). */
export async function catalogNames(
  deps: CleaningDeps,
  placeTypeId: string,
  cleaningTypeIds: readonly string[],
): Promise<{ placeTypeName: string; cleaningTypeNames: string[] }> {
  const [placeType, types] = await Promise.all([
    deps.places.getPlaceType(placeTypeId),
    deps.cleaningTypes.listCleaningTypes(),
  ]);
  return {
    placeTypeName: placeType?.name ?? '',
    cleaningTypeNames: cleaningTypeIds.map((id) => types.find((type) => type.id === id)?.name ?? id),
  };
}
