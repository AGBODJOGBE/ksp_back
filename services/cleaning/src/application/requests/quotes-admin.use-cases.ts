import { requireRecentMfa } from '@ksp/platform';
import { type SessionPricing } from '../../domain/pricing/session-price';
import { invalidTransition } from '../../domain/requests/errors';
import { deductibleVisitFeeAmount } from '../../domain/requests/visit-fee';
import {
  type AdjustmentInput,
  approveAdjustments,
  composeQuote,
  type PricedLine,
  sendQuote,
  updateQuoteDraft,
} from '../../domain/quotes/quote';
import { quoteLinesFrom } from '../../domain/quotes/quote-lines';
import { quoteBaseSessionPrice, lockRevision } from '../../domain/visits/observation';
import { type SchedulePlan } from '../../domain/schedule-plan/plan';
import { type CleaningDeps } from '../deps';
import { requireStaff } from '../shared/access';
import { previewSchedule, type SchedulePlanInput, toSchedulePlan } from '../simulation/schedule';
import { cleaningErrors } from '../shared/errors';
import { runIdempotent } from '../shared/idempotency';
import { requireUuid } from '../shared/input';
import { caseErrors, decide } from './case-errors';
import { priceCase } from './case-pricing';
import {
  audit,
  caseParty,
  catalogNames,
  effectiveQuote,
  effectiveStatus,
  iso,
  latestRevision,
  money,
  quoteById,
  saveCase,
  sentQuote,
} from './case-support';
import { comparisonOf } from './retained.use-cases';
import { type CaseRecord, type QuoteRecord } from './requests.ports';
import { CASE_PERMISSIONS, staffWith } from './staff';

/** Version des conditions générales citée par les devis (à remplacer par un réglage, voir README). */
export const CLEANING_TERMS_VERSION = 'cg-2026-11';
/** Validité choisie au back-office : de 1 à 90 jours (le réglage par défaut vaut 15). */
const MAX_VALIDITY_DAYS = 90;
/** R-DV-03 : double authentification de moins de 10 minutes pour valider une remise. */
const APPROVAL_MFA_SECONDS = 600;

export interface QuoteDraftInput {
  schedule?: SchedulePlanInput | undefined;
  teamSize?: number | undefined;
  durationMinutes?: number | undefined;
  adjustments?:
    | { kind: string; percentBps?: number | undefined; fixedAmount?: number | undefined; reason: string }[]
    | undefined;
  onQuotePrices?: { offerId: string; price: number }[] | undefined;
  validityDays?: number | undefined;
}

function adjustmentsOf(input: QuoteDraftInput['adjustments']): AdjustmentInput[] {
  return (input ?? []).map((item, index) => {
    if (item.kind !== 'discount' && item.kind !== 'surcharge') {
      throw cleaningErrors.invalid(`adjustments[${index}].kind`, 'invalid_type');
    }
    return {
      kind: item.kind,
      percentBps: item.percentBps ?? null,
      fixedAmount: item.fixedAmount ?? null,
      reason: item.reason,
    };
  });
}

function validity(days: number | undefined): number | null {
  if (days === undefined) return null;
  if (!Number.isInteger(days) || days < 1 || days > MAX_VALIDITY_DAYS)
    throw cleaningErrors.invalid('validityDays', 'out_of_range');
  return days;
}

/** Prix fixés au devis pour les offres « sur devis » (OnQuotePrice), puis lignes R-DV-07. */
function linesWith(pricing: SessionPricing, onQuote: QuoteDraftInput['onQuotePrices']): PricedLine[] {
  const fixed = new Map((onQuote ?? []).map((item) => [item.offerId, item.price]));
  for (const [offerId, price] of fixed) {
    if (!Number.isSafeInteger(price) || price <= 0)
      throw cleaningErrors.invalid(`onQuotePrices.${offerId}`, 'out_of_range');
  }
  return decide(() =>
    quoteLinesFrom({
      ...pricing,
      offers: pricing.offers.map((offer) =>
        offer.price === null && fixed.has(offer.offerId)
          ? { ...offer, price: fixed.get(offer.offerId)! }
          : offer,
      ),
    }),
  );
}

/** Une remise ou majoration exige cleaning.quote.adjust_price (R-DV-03). */
function requireAdjustPermission(adjustments: readonly AdjustmentInput[], zoneKey: string): void {
  if (adjustments.length) staffWith(CASE_PERMISSIONS.adjustPrice, zoneKey);
}

/** UC-NT-33 — Devis au back-office (R-DV-01 à R-DV-07, R-FV-05, R-CS-01, R-CS-03). */
export class QuotesAdminUseCases {
  constructor(private readonly deps: CleaningDeps) {}

  async get(quoteId: string): Promise<{ record: CaseRecord; quote: QuoteRecord }> {
    requireStaff();
    const id = requireUuid(quoteId, 'quoteId');
    const record = await this.deps.cases.findCaseByQuote(id);
    if (!record) throw caseErrors.quoteNotFound();
    staffWith(CASE_PERMISSIONS.read, record.request.communeKey);
    return { record, quote: effectiveQuote(quoteById(record, id), this.deps.clock.now()) };
  }

  /**
   * Compose les éléments du devis à partir de la version retenue : lignes du calcul du jour, ou celles
   * du simulateur si les informations sont confirmées (R-CS-01), dates recalculées, équipe proposée.
   */
  private async composition(record: CaseRecord, input: QuoteDraftInput, schedulePlan: SchedulePlan) {
    const revision = latestRevision(record);
    if (!revision) throw invalidTransition(record.request.status, 'quote_sent');
    const [priced, preview] = await Promise.all([
      priceCase(this.deps, record, {
        values: revision.values as Record<string, never>,
        cleaningTypeIds: [...revision.cleaningTypeIds],
        schedule: schedulePlan,
      }),
      previewSchedule(this.deps, schedulePlan),
    ]);
    const comparison = await comparisonOf(this.deps, record, revision);
    const confirmed = comparison.confirmed && record.request.pricingSnapshot !== null;
    const pricing = confirmed ? (record.request.pricingSnapshot as SessionPricing) : priced.pricing;
    const lines = linesWith(pricing, input.onQuotePrices);
    const linesTotal = lines.reduce((sum, line) => sum + line.amount, 0);
    return {
      revision,
      lines,
      basePrice: confirmed ? quoteBaseSessionPrice(comparison) : linesTotal,
      sessionStarts: preview.occurrences.map((occurrence) => occurrence.start),
      teamSize: input.teamSize ?? priced.pricing.teamSize ?? 1,
      durationMinutes: input.durationMinutes ?? priced.pricing.durationMinutes ?? 120,
    };
  }

  /** CreateQuote : brouillon d'un devis, ou de sa révision quand un devis est envoyé (R-DV-05). */
  async create(input: QuoteDraftInput & { requestId: string; idempotencyKey: string }) {
    requireStaff();
    const record0 = await this.deps.cases.findCase(requireUuid(input.requestId, 'requestId'));
    const staffId = staffWith(CASE_PERMISSIONS.quoteManage, record0?.request.communeKey);
    const adjustments = adjustmentsOf(input.adjustments);
    if (record0) requireAdjustPermission(adjustments, record0.request.communeKey);
    const validityDays = validity(input.validityDays);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'quote.create',
      key: input.idempotencyKey,
      body: { ...input, idempotencyKey: undefined },
      at: now,
      replay: async (response) => this.get(String(response.quoteId)),
      run: async (stub) => {
        const record = await this.deps.cases.findCase(requireUuid(input.requestId, 'requestId'));
        if (!record) throw caseErrors.requestNotFound();
        const [settings] = await Promise.all([this.deps.caseSettings.caseSettings()]);
        const schedulePlan = input.schedule ? toSchedulePlan(input.schedule) : record.request.schedulePlan;
        const composed = await decideAsync(() => this.composition(record, input, schedulePlan));
        const quote = decide(() =>
          composeQuote({
            id: this.deps.ids.next(),
            requestId: record.request.id,
            version: record.quotes.reduce((max, item) => Math.max(max, item.version), 0) + 1,
            requestStatus: effectiveStatus(record, now),
            retainedRevision: composed.revision.revision,
            lines: composed.lines,
            basePrice: composed.basePrice,
            adjustments,
            sessionStarts: composed.sessionStarts,
            teamSize: composed.teamSize,
            durationMinutes: composed.durationMinutes,
            paymentTerms: record.request.owner.kind === 'organization' ? 'monthly_invoice' : 'per_session',
            termsVersion: CLEANING_TERMS_VERSION,
            deductibleVisitFee: deductibleVisitFeeAmount(record.fees, settings.deductVisitFee),
            discountApprovalThresholdPercent: settings.maxDiscountWithoutApprovalPct,
            firstSessionLeadHours: settings.firstSessionLeadHours,
            createdBy: staffId,
            now,
          }),
        );
        const draft: QuoteRecord = { ...quote, schedulePlan, sentBy: null, validityDays };
        const saved = await saveCase(
          this.deps,
          { ...record, quotes: [...record.quotes, draft] },
          record.request.version,
          {
            changes: {
              events: [],
              audit: [
                audit(staffId, 'quote.created', 'quote', draft.id, now, {
                  requestId: record.request.id,
                  sessionPrice: draft.sessionPrice,
                  total: draft.total,
                }),
              ],
              idempotency: stub({ quoteId: draft.id }),
            },
          },
        );
        return { record: saved, quote: draft };
      },
    });
  }

  /** UpdateQuoteDraft : brouillon seulement, champs absents inchangés, devis recalculé. */
  async updateDraft(input: QuoteDraftInput & { quoteId: string; replaceAdjustments: boolean }) {
    requireStaff();
    const { record, quote } = await this.get(input.quoteId);
    const staffId = staffWith(CASE_PERMISSIONS.quoteManage, record.request.communeKey);
    const adjustments = input.replaceAdjustments ? adjustmentsOf(input.adjustments) : null;
    if (adjustments) requireAdjustPermission(adjustments, record.request.communeKey);
    const now = this.deps.clock.now();
    const settings = await this.deps.caseSettings.caseSettings();
    const schedulePlan = input.schedule ? toSchedulePlan(input.schedule) : quote.schedulePlan;
    const preview = input.schedule ? await previewSchedule(this.deps, schedulePlan) : null;
    const lines = input.onQuotePrices
      ? (await this.composition(record, input, schedulePlan)).lines
      : undefined;
    const updated = decide(() =>
      updateQuoteDraft(
        quote,
        {
          ...(preview ? { sessionStarts: preview.occurrences.map((occurrence) => occurrence.start) } : {}),
          ...(input.teamSize !== undefined ? { teamSize: input.teamSize } : {}),
          ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
          ...(adjustments ? { adjustments } : {}),
          ...(lines ? { lines, basePrice: lines.reduce((sum, line) => sum + line.amount, 0) } : {}),
        },
        {
          requestStatus: effectiveStatus(record, now),
          deductibleVisitFee: deductibleVisitFeeAmount(record.fees, settings.deductVisitFee),
          discountApprovalThresholdPercent: settings.maxDiscountWithoutApprovalPct,
          firstSessionLeadHours: settings.firstSessionLeadHours,
          now,
        },
      ),
    );
    const next: QuoteRecord = {
      ...quote,
      ...updated,
      schedulePlan,
      validityDays: input.validityDays !== undefined ? validity(input.validityDays) : quote.validityDays,
    };
    const saved = await saveCase(
      this.deps,
      { ...record, quotes: record.quotes.map((item) => (item.id === quote.id ? next : item)) },
      record.request.version,
      {
        changes: {
          events: [],
          audit: [
            audit(staffId, 'quote.updated', 'quote', quote.id, now, { sessionPrice: next.sessionPrice }),
          ],
        },
      },
    );
    return { record: saved, quote: next };
  }

  /** ApproveQuoteAdjustment (R-DV-03) : une autre personne que l'auteur, MFA de moins de 10 min. */
  async approveAdjustment(input: { quoteId: string; idempotencyKey: string }) {
    requireStaff();
    const { record: record0 } = await this.get(input.quoteId);
    const staffId = staffWith(CASE_PERMISSIONS.adjustPrice, record0.request.communeKey);
    requireRecentMfa(APPROVAL_MFA_SECONDS);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'quote.adjustment.approve',
      key: input.idempotencyKey,
      body: { quoteId: input.quoteId },
      at: now,
      replay: async () => this.get(input.quoteId),
      run: async (stub) => {
        const { record, quote } = await this.get(input.quoteId);
        const approved: QuoteRecord = { ...quote, ...decide(() => approveAdjustments(quote, staffId)) };
        const saved = await saveCase(
          this.deps,
          { ...record, quotes: record.quotes.map((item) => (item.id === quote.id ? approved : item)) },
          record.request.version,
          {
            changes: {
              events: [],
              audit: [audit(staffId, 'quote.adjustment_approved', 'quote', quote.id, now)],
              idempotency: stub({ quoteId: quote.id }),
            },
          },
        );
        return { record: saved, quote: approved };
      },
    });
  }

  /**
   * SendQuote (R-DV-02, R-DV-04, R-DV-05, R-DV-07, R-CS-03) : prix figé, dates recalculées, validité,
   * révision retenue figée ; une révision remplace le devis envoyé (`superseded`).
   */
  async send(input: { quoteId: string; idempotencyKey: string }) {
    requireStaff();
    const { record: record0 } = await this.get(input.quoteId);
    const staffId = staffWith(CASE_PERMISSIONS.quoteManage, record0.request.communeKey);
    const now = this.deps.clock.now();
    return runIdempotent({
      store: this.deps.idempotency,
      actorId: staffId,
      operation: 'quote.send',
      key: input.idempotencyKey,
      body: { quoteId: input.quoteId },
      at: now,
      replay: async () => this.get(input.quoteId),
      run: async (stub) => {
        const { record, quote } = await this.get(input.quoteId);
        const settings = await this.deps.caseSettings.caseSettings();
        const preview = await previewSchedule(this.deps, quote.schedulePlan);
        const previous = sentQuote(record);
        const sent = decide(() =>
          sendQuote({
            quote,
            requestStatus: effectiveStatus(record, now),
            previous,
            sessionStarts: preview.occurrences.map((occurrence) => occurrence.start),
            validityDays: quote.validityDays ?? settings.quoteValidityDays,
            firstSessionLeadHours: settings.firstSessionLeadHours,
            now,
          }),
        );
        const revisions = decide(() => lockRevision(record.revisions, quote.retainedRevision, now));
        const sentRecord: QuoteRecord = { ...quote, ...sent.quote, sentBy: staffId };
        const next: CaseRecord = {
          ...record,
          request: { ...record.request, status: sent.requestStatus, updatedAt: now },
          revisions: record.revisions.map((revision) => ({
            ...revision,
            lockedAt:
              revisions.find((item) => item.revision === revision.revision)?.lockedAt ?? revision.lockedAt,
          })),
          quotes: record.quotes.map((item) => {
            if (item.id === quote.id) return sentRecord;
            if (sent.superseded && item.id === sent.superseded.id)
              return { ...item, status: 'superseded' as const };
            return item;
          }),
        };
        const names = await catalogNames(
          this.deps,
          record.request.placeTypeId,
          record.request.cleaningTypeIds,
        );
        const saved = await saveCase(this.deps, next, record.request.version, {
          changes: {
            events: [
              {
                type: 'cleaning.quote.sent',
                payload: {
                  ...caseParty(record.request),
                  quoteId: quote.id,
                  kind: 'initial',
                  version: quote.version,
                  sessionPrice: money(sentRecord.sessionPrice),
                  sessionsCount: sentRecord.sessionsCount,
                  total: money(sentRecord.total),
                  visitFeeDeduction: money(sentRecord.visitFeeDeduction),
                  validUntil: iso(sentRecord.validUntil as Date),
                  sentAt: iso(now),
                  ...names,
                },
              },
            ],
            audit: [
              audit(staffId, 'quote.sent', 'quote', quote.id, now, {
                total: sentRecord.total,
                ...(sent.superseded ? { supersededQuoteId: sent.superseded.id } : {}),
              }),
            ],
            idempotency: stub({ quoteId: quote.id }),
          },
        });
        return { record: saved, quote: sentRecord };
      },
    });
  }
}

/** Traduit les refus du domaine levés par une composition asynchrone. */
async function decideAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return decide(() => {
      throw error;
    });
  }
}
