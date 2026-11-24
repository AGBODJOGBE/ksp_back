import { type cleaningV1 } from '@ksp/contracts';
import { type CleaningDeps } from '../../application/deps';
import { type AcceptedQuote } from '../../application/requests/client-quotes.use-cases';
import {
  effectiveQuote,
  effectiveStatus,
  latestRevision,
  sentQuote,
} from '../../application/requests/case-support';
import { decryptLocation } from '../../application/requests/locations';
import {
  type CaseRecord,
  type QuoteRecord,
  type RequestRecord,
  type RevisionRecord,
  type VisitRecord,
} from '../../application/requests/requests.ports';
import { SIMULATION_DISCLAIMER } from '../../application/simulation/simulate.use-cases';
import { isInForce } from '../../domain/planning/assignment-status';
import { type SessionPricing } from '../../domain/pricing/session-price';
import { buildComparison, type ComparisonRow } from '../../domain/visits/observation';
import { effectiveVisitStatus } from '../../domain/visits/visit';
import { maybeMoney, money } from './catalog.presenters';
import {
  isoOf,
  opt,
  parameterValue,
  parameterValues,
  photos,
  placeLocation,
  schedulePlan,
} from './case-values.presenters';
import { presentSimulation } from './simulation.presenters';

/**
 * Vues du dossier (lot C). Le client voit son dossier sans le constat brut de l'agent ni les
 * brouillons de devis (R-CS-02, R-DV-01) ; le personnel voit tout, montants seulement avec
 * cleaning.amounts.read (R-EX-04). Les noms du catalogue sont ceux en vigueur, éléments désactivés
 * compris (RV-46).
 */
export interface Audience {
  kind: 'customer' | 'staff' | 'agent';
  amounts: boolean;
}

interface Lookups {
  placeTypes: Map<string, string>;
  types: Map<string, { code: string; name: string }>;
  parameters: Map<string, { label: string; unit: string | null; kind: string }>;
  communes: Map<string, string>;
  users: Map<string, string>;
  organizations: Map<string, string>;
}

export class CasePresenter {
  constructor(private readonly deps: CleaningDeps) {}

  private async lookups(records: readonly CaseRecord[], audience: Audience): Promise<Lookups> {
    const staff = audience.kind === 'staff';
    const [placeTypes, types, parameters, communes, users, organizations] = await Promise.all([
      this.deps.places.listPlaceTypes(),
      this.deps.cleaningTypes.listCleaningTypes(),
      this.deps.parameters.listParameters(),
      this.deps.communes.listCommunes().catch(() => []),
      staff
        ? this.deps.people.userNames(records.map((r) => r.request.submittedBy))
        : Promise.resolve(new Map<string, string>()),
      staff
        ? this.deps.people.organizationNames(
            records.filter((r) => r.request.owner.kind === 'organization').map((r) => r.request.owner.id),
          )
        : Promise.resolve(new Map<string, string>()),
    ]);
    return {
      placeTypes: new Map(placeTypes.map((item) => [item.id, item.name])),
      types: new Map(types.map((item) => [item.id, { code: item.code, name: item.name }])),
      parameters: new Map(
        parameters.map((item) => [item.code, { label: item.label, unit: item.unit, kind: item.kind }]),
      ),
      communes: new Map(communes.map((item) => [item.key, item.name])),
      users,
      organizations,
    };
  }

  private typeRefs(ids: readonly string[], lookups: Lookups): cleaningV1.CleaningTypeRef[] {
    return ids.map((id) => ({
      id,
      code: lookups.types.get(id)?.code ?? '',
      name: lookups.types.get(id)?.name ?? '',
    }));
  }

  private party(request: RequestRecord, lookups: Lookups, audience: Audience) {
    const staff = audience.kind === 'staff';
    return {
      customerKind: request.owner.kind === 'organization' ? 'organization' : 'individual',
      customerId: request.submittedBy,
      organizationId: request.owner.kind === 'organization' ? request.owner.id : undefined,
      customerName: staff ? opt(lookups.users.get(request.submittedBy)) : undefined,
      organizationName:
        staff && request.owner.kind === 'organization'
          ? opt(lookups.organizations.get(request.owner.id))
          : undefined,
    };
  }

  private place(record: CaseRecord, lookups: Lookups): cleaningV1.PlaceSummary {
    const { request } = record;
    return {
      placeId: request.placeId,
      name: '',
      placeTypeId: request.placeTypeId,
      placeTypeName: lookups.placeTypes.get(request.placeTypeId) ?? '',
      communeKey: request.communeKey,
      communeName: lookups.communes.get(request.communeKey) ?? request.communeKey,
      location: placeLocation(decryptLocation(this.deps.cipher, 'request', request.id, request)),
    };
  }

  async summaries(records: readonly CaseRecord[], audience: Audience): Promise<cleaningV1.RequestSummary[]> {
    const lookups = await this.lookups(records, audience);
    const now = this.deps.clock.now();
    return records.map((record) => {
      const next = record.visits.find((visit) => visit.status === 'scheduled');
      return {
        id: record.request.id,
        number: record.request.number,
        status: effectiveStatus(record, now),
        ...this.party(record.request, lookups, audience),
        placeTypeName: lookups.placeTypes.get(record.request.placeTypeId) ?? '',
        communeKey: record.request.communeKey,
        communeName: lookups.communes.get(record.request.communeKey) ?? record.request.communeKey,
        cleaningTypes: this.typeRefs(record.request.cleaningTypeIds, lookups),
        nextVisitAt: isoOf(next?.scheduledStart),
        createdAt: record.request.createdAt.toISOString(),
        updatedAt: record.request.updatedAt.toISOString(),
      };
    });
  }

  private pricing(snapshot: unknown, visitFee: number, at: Date): cleaningV1.Pricing | undefined {
    if (!snapshot || typeof snapshot !== 'object' || !('offers' in snapshot)) return undefined;
    return presentSimulation({
      pricing: snapshot as SessionPricing,
      schedule: null,
      visitFee,
      calculatedAt: at,
      disclaimer: SIMULATION_DISCLAIMER,
      cleaningTypeCodes: {},
    }).pricing;
  }

  /** Comparaison montrée (R-CS-01, R-CS-02), effets sur le prix relus dans la révision enregistrée. */
  private comparison(
    record: CaseRecord,
    revision: RevisionRecord,
    lookups: Lookups,
    audience: Audience,
  ): cleaningV1.Comparison {
    const stored = new Map(
      (revision.diff as ComparisonRow[]).map((row) => [row.parameterCode, row.priceEffect]),
    );
    const visit = [...record.visits].reverse().find((item) => item.observedValues);
    const comparison = buildComparison({
      declared: {
        values: record.request.declaredValues,
        cleaningTypeIds: record.request.cleaningTypeIds,
        sessionPrice: record.request.estimatedSessionPrice ?? 0,
      },
      observed: visit?.observedValues ?? null,
      retained: revision,
      priceEffects: Object.fromEntries(stored),
    });
    const agentNote = (code: string) =>
      revision.reasons.find((reason) => reason.parameterCode === code)?.reason;
    return {
      confirmed: comparison.confirmed,
      rows: comparison.rows.map((row) => ({
        parameterCode: row.parameterCode,
        label: lookups.parameters.get(row.parameterCode)?.label ?? row.parameterCode,
        unit: opt(lookups.parameters.get(row.parameterCode)?.unit),
        declared: parameterValue(row.declared),
        observed: audience.kind === 'customer' ? undefined : parameterValue(row.observed),
        retained: parameterValue(row.retained),
        priceEffect: audience.amounts ? money(row.priceEffect) : undefined,
        reason: opt(agentNote(row.parameterCode)),
      })),
      addedCleaningTypes: this.typeRefs(comparison.addedCleaningTypeIds, lookups),
      removedCleaningTypes: this.typeRefs(comparison.removedCleaningTypeIds, lookups),
      declaredSessionPrice: audience.amounts ? money(comparison.declaredSessionPrice) : undefined,
      retainedSessionPrice: audience.amounts ? money(comparison.retainedSessionPrice) : undefined,
    };
  }

  async visit(record: CaseRecord, visit: VisitRecord, audience: Audience): Promise<cleaningV1.Visit> {
    const now = this.deps.clock.now();
    const [target] = await this.deps.planning.targets([{ kind: 'visit', id: visit.id }]);
    const live = (target?.assignments ?? []).filter((item) => isInForce(item, now));
    const agents = live.length ? await this.deps.planning.agentsByIds(live.map((item) => item.agentId)) : [];
    const stored =
      visit.photoFileIds.length || visit.missedPhotoFileId
        ? await this.deps.photos.list({ type: 'cleaning_visit', id: visit.id }).catch(() => [])
        : [];
    return {
      id: visit.id,
      requestId: record.request.id,
      requestNumber: record.request.number,
      status: effectiveVisitStatus(visit, effectiveStatus(record, now)),
      scheduledAt: visit.scheduledStart.toISOString(),
      durationMinutes: visit.durationMinutes,
      travelMinutes: opt(live[0]?.travelMinutes),
      agents: live.map((item) => {
        const agent = agents.find((candidate) => candidate.id === item.agentId);
        const [firstName = '', ...rest] = (agent?.displayName ?? '').split(' ');
        return {
          agentId: item.agentId,
          firstName,
          lastName: rest.join(' '),
          isLead: item.isLead,
          confirmation:
            item.status === 'confirmed' ? 'confirmed' : item.status === 'proposed' ? 'proposed' : 'pending',
        };
      }),
      arrival: visit.arrivedAt
        ? {
            arrivedAt: visit.arrivedAt.toISOString(),
            distanceMeters: opt(visit.arrivalDistanceM),
            alert: false,
            uncertain: false,
          }
        : undefined,
      observedValues: audience.kind === 'customer' ? {} : parameterValues(visit.observedValues),
      photos: [
        ...photos(visit.photoFileIds, stored, 'visit'),
        ...(visit.missedPhotoFileId ? photos([visit.missedPhotoFileId], stored, 'absence') : []),
      ],
      completedAt: isoOf(visit.completedAt),
      missedAt: isoOf(visit.missedAt),
      cancelledAt: isoOf(visit.cancelledAt),
      cancelCause: opt(visit.cancelCause),
      note: audience.kind === 'customer' ? undefined : opt(visit.observationNote),
    };
  }

  quote(
    record: CaseRecord,
    quote: QuoteRecord,
    lookups: Lookups | null,
    audience: Audience,
  ): cleaningV1.Quote {
    const shown = effectiveQuote(quote, this.deps.clock.now());
    const amount = (value: number) => (audience.amounts ? money(value) : undefined);
    const revision = record.revisions.find((item) => item.revision === quote.retainedRevision);
    return {
      id: quote.id,
      requestId: record.request.id,
      requestNumber: record.request.number,
      programId: quoteProgramId(record, quote, shown.status),
      kind: quote.kind,
      version: quote.version,
      status: shown.status,
      place: lookups ? this.place(record, lookups) : undefined,
      lines: quote.lines.map((line) => ({
        offerId: line.offerId,
        cleaningTypeId: line.cleaningTypeId,
        name: line.name,
        quantity: line.quantity,
        unit: opt(line.unit),
        unitPrice: amount(line.unitPrice),
        amount: amount(line.amount),
        kind: line.kind,
      })),
      adjustments: quote.adjustments.map((item) => ({
        kind: item.kind,
        percentBps: opt(item.percentBps),
        fixedAmount:
          item.fixedAmount !== null && item.fixedAmount !== undefined ? amount(item.fixedAmount) : undefined,
        amount: amount(item.amount),
        reason: item.reason,
        approvalStatus: item.approvalStatus,
        approvedBy: opt(item.approvedBy),
      })),
      sessionPrice: amount(quote.sessionPrice),
      sessionsCount: quote.sessionsCount,
      sessionStarts: quote.sessionStarts.map((start) => start.toISOString()),
      total: amount(quote.total),
      visitFeeDeduction: amount(quote.visitFeeDeduction),
      teamSize: quote.teamSize,
      durationMinutes: quote.durationMinutes,
      schedule: schedulePlan(quote.schedulePlan),
      paymentTerms: quote.paymentTerms,
      comparison: lookups && revision ? this.comparison(record, revision, lookups, audience) : undefined,
      validUntil: isoOf(quote.validUntil),
      termsVersion: quote.termsVersion,
      sentAt: isoOf(quote.sentAt),
      respondedAt: isoOf(quote.respondedAt),
      createdAt: quote.createdAt.toISOString(),
      retainedRevision: quote.retainedRevision,
    };
  }

  async quoteView(record: CaseRecord, quote: QuoteRecord, audience: Audience): Promise<cleaningV1.Quote> {
    return this.quote(record, quote, await this.lookups([record], audience), audience);
  }

  async request(record: CaseRecord, audience: Audience): Promise<cleaningV1.Request> {
    const lookups = await this.lookups([record], audience);
    const { request } = record;
    const now = this.deps.clock.now();
    const customer = audience.kind === 'customer';
    const quotes = customer ? record.quotes.filter((quote) => quote.status !== 'draft') : record.quotes;
    const current = sentQuote(record) ?? latestAccepted(record);
    const revision = latestRevision(record);
    const showComparison = revision && (!customer || current !== null);
    const fees = [...record.fees].sort((a, b) => b.rank - a.rank);
    const fee = (item: (typeof fees)[number]): cleaningV1.VisitFee => ({
      id: item.id,
      rank: item.rank,
      amount: audience.amounts ? money(item.amount) : undefined,
      status: item.status,
      payBefore: isoOf(item.dueAt),
      paidAt: isoOf(item.paidAt),
      refundedAt: isoOf(item.refundedAt),
    });
    const stored = request.photoFileIds.length
      ? await this.deps.photos.list({ type: 'cleaning_request', id: request.id }).catch(() => [])
      : [];
    const visits = await Promise.all(
      [...record.visits]
        .sort((a, b) => b.attempt - a.attempt)
        .map((visit) => this.visit(record, visit, audience)),
    );
    const reactivation = record.reactivations.at(-1);
    return {
      id: request.id,
      number: request.number,
      status: effectiveStatus(record, now),
      ...this.party(request, lookups, audience),
      place: this.place(record, lookups),
      cleaningTypes: this.typeRefs(request.cleaningTypeIds, lookups),
      declaredValues: parameterValues(request.declaredValues),
      freeDescription: opt(request.description),
      comment: opt(request.comment),
      photos: photos(request.photoFileIds, stored, 'request'),
      schedule: schedulePlan(request.schedulePlan),
      visitSlots: request.visitSlots.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      })),
      declaredPricing: audience.amounts
        ? this.pricing(request.pricingSnapshot, record.fees[0]?.amount ?? 0, request.createdAt)
        : undefined,
      visitFee: fees[0] ? fee(fees[0]) : undefined,
      visits,
      retained:
        revision && !customer
          ? {
              values: parameterValues(revision.values as never),
              cleaningTypes: this.typeRefs(revision.cleaningTypeIds, lookups),
              reasons: revision.reasons.map((reason) => ({
                parameterCode: opt(reason.parameterCode),
                cleaningTypeId: opt(reason.cleaningTypeId),
                reason: reason.reason,
              })),
              pricing: audience.amounts
                ? this.pricing(revision.pricingSnapshot, 0, revision.updatedAt)
                : undefined,
              authorId: revision.authorId,
              updatedAt: revision.updatedAt.toISOString(),
              locked: revision.lockedAt !== null,
              revision: revision.revision,
              reason: opt(revision.reason),
            }
          : undefined,
      comparison:
        showComparison && revision ? this.comparison(record, revision, lookups, audience) : undefined,
      currentQuote: current ? this.quote(record, current, null, audience) : undefined,
      quoteHistory: quotes
        .filter((quote) => quote.id !== current?.id)
        .map((quote) => this.quote(record, quote, null, audience)),
      programId: opt(record.programId),
      reactivation: reactivation
        ? {
            requestedAt: reactivation.requestedAt.toISOString(),
            status: reactivation.status,
            decidedAt: isoOf(reactivation.decidedAt),
          }
        : undefined,
      createdAt: request.createdAt.toISOString(),
      updatedAt: request.updatedAt.toISOString(),
      declaredRows: request.declaredRows.map((row) => {
        const definition = lookups.parameters.get(row.parameterCode);
        return {
          code: row.parameterCode,
          label: row.label,
          kind:
            definition?.kind ??
            (typeof row.value === 'number'
              ? 'number'
              : typeof row.value === 'boolean'
                ? 'boolean'
                : 'choice'),
          unit: opt(row.unit),
          value: parameterValue(row.value),
          display:
            typeof row.value === 'boolean'
              ? row.value
                ? 'Oui'
                : 'Non'
              : `${row.value}${row.unit ? ` ${row.unit}` : ''}`,
        };
      }),
      visitFees: fees.map(fee),
      warnings: [],
    };
  }

  /** Programme confirmé à l'acceptation (AcceptQuoteResult.program), sans séance réalisée. */
  async program(accepted: AcceptedQuote, audience: Audience): Promise<cleaningV1.Program> {
    const lookups = await this.lookups([accepted.record], audience);
    const { program, record } = accepted;
    return {
      id: program.id,
      number: program.number ?? record.programNumber ?? '',
      status: 'confirmed',
      requestId: program.requestId,
      quoteId: program.quoteId,
      ...this.party(record.request, lookups, audience),
      payerKind: program.payerKind,
      place: this.place(record, lookups),
      cleaningTypes: this.typeRefs(record.request.cleaningTypeIds, lookups),
      schedule: schedulePlan(program.schedulePlan),
      sessionsCount: program.sessions.length,
      sessionsCompleted: 0,
      sessionPrice: maybeMoney(audience.amounts ? program.sessionPrice : null),
      total: maybeMoney(audience.amounts ? program.sessionPrice * program.sessions.length : null),
      firstSessionAt: isoOf(
        program.sessions[0]?.scheduledStart ? new Date(program.sessions[0].scheduledStart) : null,
      ),
      lastSessionAt: isoOf(
        program.sessions.at(-1)?.scheduledStart ? new Date(program.sessions.at(-1)!.scheduledStart) : null,
      ),
      suspensionCauses: [],
      createdAt: new Date(program.createdAt).toISOString(),
    };
  }
}

/**
 * Programme d'un devis (contrat Quote.program_id) : celui que complète un avenant ; sinon, une fois
 * le devis accepté, celui qu'il a créé (le premier programme de la demande, ou le renouvellement).
 */
function quoteProgramId(record: CaseRecord, quote: QuoteRecord, status: string): string | undefined {
  if (quote.kind === 'amendment') return opt(quote.programId);
  if (status !== 'accepted') return undefined;
  return opt(quote.createdProgramId ?? (quote.kind === 'renewal' ? null : record.programId));
}

/** Devis accepté le plus récent : un renouvellement accepté passe devant le devis d'origine. */
function latestAccepted(record: CaseRecord): QuoteRecord | null {
  return (
    [...record.quotes].sort((a, b) => b.version - a.version).find((quote) => quote.status === 'accepted') ??
    null
  );
}
