import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import { LOT_C_USE_CASES, type LotCUseCases } from '../../application/requests/lot-c-use-cases';
import { type CaseRecord, type QuoteRecord } from '../../application/requests/requests.ports';
import { seesAmounts } from '../../application/requests/staff';
import { type Audience, CasePresenter } from './case.presenters';
import { declaredFromProto } from './case-values.presenters';
import { presentSimulation, scheduleFromProto } from './simulation.presenters';

/**
 * Adaptateur gRPC de RequestAdminService — back-office : demandes, visites, constat retenu, devis
 * (UC-NT-30 à 33). Lot C. Montants rendus seulement avec cleaning.amounts.read (R-EX-04).
 */
@Controller()
@cleaningV1.RequestAdminServiceControllerMethods()
export class RequestAdminGrpcController implements cleaningV1.RequestAdminServiceController {
  private readonly presenter: CasePresenter;

  constructor(
    @Inject(LOT_C_USE_CASES) private readonly useCases: LotCUseCases,
    @Inject(CLEANING_DEPS) private readonly deps: CleaningDeps,
  ) {
    this.presenter = new CasePresenter(deps);
  }

  private audience(zoneKey?: string): Audience {
    return { kind: 'staff', amounts: seesAmounts(zoneKey) };
  }

  private async request(record: CaseRecord): Promise<{ request: cleaningV1.Request }> {
    const fresh = (await this.deps.cases.findCase(record.request.id)) ?? record;
    return { request: await this.presenter.request(fresh, this.audience(fresh.request.communeKey)) };
  }

  private async visit(record: CaseRecord, visitId: string): Promise<{ visit: cleaningV1.Visit }> {
    const fresh = (await this.deps.cases.findCase(record.request.id)) ?? record;
    const visit = fresh.visits.find((item) => item.id === visitId) ?? fresh.visits.at(-1)!;
    return { visit: await this.presenter.visit(fresh, visit, this.audience(fresh.request.communeKey)) };
  }

  private async quote(record: CaseRecord, quote: QuoteRecord): Promise<{ quote: cleaningV1.Quote }> {
    return { quote: await this.presenter.quoteView(record, quote, this.audience(record.request.communeKey)) };
  }

  async listRequests(request: cleaningV1.ListRequestsRequest): Promise<cleaningV1.ListRequestsResponse> {
    const page = await this.useCases.requestAdmin.list(request);
    return {
      items: await this.presenter.summaries(page.items, this.audience()),
      nextCursor: page.nextCursor ?? '',
      total: page.total,
    };
  }

  async getRequest(request: cleaningV1.GetRequestRequest): Promise<cleaningV1.GetRequestResponse> {
    return this.request(await this.useCases.requestAdmin.get(request.requestId));
  }

  async rejectRequest(request: cleaningV1.RejectRequestRequest): Promise<cleaningV1.RejectRequestResponse> {
    return this.request(await this.useCases.requestAdmin.reject(request));
  }

  async correctRequestLocation(
    request: cleaningV1.CorrectRequestLocationRequest,
  ): Promise<cleaningV1.CorrectRequestLocationResponse> {
    const corrected = await this.useCases.requestAdmin.correctLocation(request);
    const { record } = corrected;
    const communes = await this.deps.communes.listCommunes().catch(() => []);
    return {
      locationCorrection: {
        requestId: record.request.id,
        communeKey: record.request.communeKey,
        communeName:
          communes.find((item) => item.key === record.request.communeKey)?.name ?? record.request.communeKey,
        communeChanged: corrected.communeChanged,
        placeUpdated: corrected.placeUpdated,
        correctedAt: corrected.correctedAt.toISOString(),
      },
    };
  }

  async decideReactivation(
    request: cleaningV1.DecideReactivationRequest,
  ): Promise<cleaningV1.DecideReactivationResponse> {
    return this.request(await this.useCases.requestAdmin.decideReactivation(request));
  }

  async listVisits(request: cleaningV1.ListVisitsRequest): Promise<cleaningV1.ListVisitsResponse> {
    const page = await this.useCases.visitsAdmin.list(request);
    const items: cleaningV1.Visit[] = [];
    for (const { visit, request: owner } of page.items) {
      const record = await this.deps.cases.findCase(owner.id);
      if (record) items.push(await this.presenter.visit(record, visit, this.audience(owner.communeKey)));
    }
    return { items, nextCursor: page.nextCursor ?? '', total: page.total };
  }

  async scheduleVisit(request: cleaningV1.ScheduleVisitRequest): Promise<cleaningV1.ScheduleVisitResponse> {
    const record = await this.useCases.visitsAdmin.schedule({
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      scheduledAt: request.scheduledAt,
      durationMinutes: request.durationMinutes,
      agentIds: request.agentIds,
      leadAgentId: request.leadAgentId,
      overrides: request.overrides,
    });
    const visit = [...record.visits].sort((a, b) => b.attempt - a.attempt)[0]!;
    return this.visit(record, visit.id);
  }

  async updateVisit(request: cleaningV1.UpdateVisitRequest): Promise<cleaningV1.UpdateVisitResponse> {
    const record = await this.useCases.visitsAdmin.update({
      visitId: request.visitId,
      idempotencyKey: request.idempotencyKey,
      scheduledAt: request.scheduledAt,
      durationMinutes: request.durationMinutes,
      agentIds: request.agentIds?.items,
      leadAgentId: request.leadAgentId,
      overrides: request.overrides?.items,
      reason: request.reason,
    });
    return this.visit(record, request.visitId);
  }

  async cancelVisit(request: cleaningV1.CancelVisitRequest): Promise<cleaningV1.CancelVisitResponse> {
    return this.visit(await this.useCases.visitsAdmin.cancel(request), request.visitId);
  }

  async requestNewVisit(
    request: cleaningV1.RequestNewVisitRequest,
  ): Promise<cleaningV1.RequestNewVisitResponse> {
    return this.request(await this.useCases.visitsAdmin.requestNewVisit(request));
  }

  async completeVisitOnBehalf(
    request: cleaningV1.CompleteVisitOnBehalfRequest,
  ): Promise<cleaningV1.CompleteVisitOnBehalfResponse> {
    const record = await this.useCases.visitsAdmin.completeOnBehalf({
      visitId: request.visitId,
      idempotencyKey: request.idempotencyKey,
      reason: request.reason,
      arrivedAt: request.arrivedAt,
      completedAt: request.completedAt,
      values: declaredFromProto(request.values),
      photoFileIds: request.photoFileIds,
    });
    return this.visit(record, request.visitId);
  }

  async reportVisitMissedOnBehalf(
    request: cleaningV1.ReportVisitMissedOnBehalfRequest,
  ): Promise<cleaningV1.ReportVisitMissedOnBehalfResponse> {
    return this.visit(await this.useCases.visitsAdmin.missedOnBehalf(request), request.visitId);
  }

  async removeVisitPhotoAsKsp(
    request: cleaningV1.RemoveVisitPhotoAsKspRequest,
  ): Promise<cleaningV1.RemoveVisitPhotoAsKspResponse> {
    return this.visit(await this.useCases.visitsAdmin.removePhotoAsKsp(request), request.visitId);
  }

  async saveRetainedValues(
    request: cleaningV1.SaveRetainedValuesRequest,
  ): Promise<cleaningV1.SaveRetainedValuesResponse> {
    const saved = await this.useCases.retained.save({
      requestId: request.requestId,
      values: declaredFromProto(request.values),
      cleaningTypeIds: request.cleaningTypeIds,
      reasons: request.reasons,
      reason: request.reason,
    });
    return this.request(saved.record);
  }

  async estimateRetainedValues(
    request: cleaningV1.EstimateRetainedValuesRequest,
  ): Promise<cleaningV1.EstimateRetainedValuesResponse> {
    const { result, record } = await this.useCases.retained.estimate({
      requestId: request.requestId,
      values: declaredFromProto(request.values),
      cleaningTypeIds: request.cleaningTypeIds,
    });
    // Montants absents sans cleaning.amounts.read (R-EX-04) : rien n'est rendu du calcul.
    return {
      pricing: this.audience(record.request.communeKey).amounts
        ? presentSimulation(result).pricing
        : undefined,
    };
  }

  private draftInput(request: {
    schedule?: cleaningV1.SchedulePlan | undefined;
    teamSize?: number | undefined;
    durationMinutes?: number | undefined;
    validityDays?: number | undefined;
  }) {
    return {
      schedule: scheduleFromProto(request.schedule),
      teamSize: request.teamSize,
      durationMinutes: request.durationMinutes,
      validityDays: request.validityDays,
    };
  }

  private adjustments(items: readonly cleaningV1.AdjustmentInput[]) {
    return items.map((item) => ({
      kind: item.kind,
      percentBps: item.percentBps,
      fixedAmount: item.fixedAmount ? Number(item.fixedAmount.amount) : undefined,
      reason: item.reason,
    }));
  }

  private onQuote(items: readonly cleaningV1.OnQuotePrice[]) {
    return items.map((item) => ({ offerId: item.offerId, price: Number(item.price?.amount ?? 0) }));
  }

  async createQuote(request: cleaningV1.CreateQuoteRequest): Promise<cleaningV1.CreateQuoteResponse> {
    const { record, quote } = await this.useCases.quotesAdmin.create({
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      ...this.draftInput(request),
      adjustments: this.adjustments(request.adjustments),
      onQuotePrices: this.onQuote(request.onQuotePrices),
    });
    return this.quote(record, quote);
  }

  async getQuote(request: cleaningV1.GetQuoteRequest): Promise<cleaningV1.GetQuoteResponse> {
    const { record, quote } = await this.useCases.quotesAdmin.get(request.quoteId);
    return this.quote(record, quote);
  }

  async updateQuoteDraft(
    request: cleaningV1.UpdateQuoteDraftRequest,
  ): Promise<cleaningV1.UpdateQuoteDraftResponse> {
    const { record, quote } = await this.useCases.quotesAdmin.updateDraft({
      quoteId: request.quoteId,
      ...this.draftInput(request),
      replaceAdjustments: request.adjustments !== undefined,
      adjustments: this.adjustments(request.adjustments?.items ?? []),
      onQuotePrices: request.onQuotePrices ? this.onQuote(request.onQuotePrices.items) : undefined,
    });
    return this.quote(record, quote);
  }

  async approveQuoteAdjustment(
    request: cleaningV1.ApproveQuoteAdjustmentRequest,
  ): Promise<cleaningV1.ApproveQuoteAdjustmentResponse> {
    const { record, quote } = await this.useCases.quotesAdmin.approveAdjustment(request);
    return this.quote(record, quote);
  }

  async sendQuote(request: cleaningV1.SendQuoteRequest): Promise<cleaningV1.SendQuoteResponse> {
    const { record, quote } = await this.useCases.quotesAdmin.send(request);
    return this.quote(record, quote);
  }
}
