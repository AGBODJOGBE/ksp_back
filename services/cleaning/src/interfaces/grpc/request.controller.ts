import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import { LOT_C_USE_CASES, type LotCUseCases } from '../../application/requests/lot-c-use-cases';
import { type CaseRecord } from '../../application/requests/requests.ports';
import { money } from './catalog.presenters';
import { type Audience, CasePresenter } from './case.presenters';
import { opt } from './case-values.presenters';
import { scheduleFromProto, valuesFromProto } from './simulation.presenters';

/** Le client titulaire voit toujours ses montants (R-EX-04). */
const CUSTOMER: Audience = { kind: 'customer', amounts: true };

/**
 * Adaptateur gRPC de RequestService — demandes de devis, frais de visite, devis du client (UC-NT-04
 * à 10). Lot C.
 */
@Controller()
@cleaningV1.RequestServiceControllerMethods()
export class RequestGrpcController implements cleaningV1.RequestServiceController {
  private readonly presenter: CasePresenter;

  constructor(
    @Inject(LOT_C_USE_CASES) private readonly useCases: LotCUseCases,
    @Inject(CLEANING_DEPS) deps: CleaningDeps,
  ) {
    this.presenter = new CasePresenter(deps);
  }

  private async view(record: CaseRecord): Promise<{ request: cleaningV1.Request }> {
    return { request: await this.presenter.request(record, CUSTOMER) };
  }

  async submitRequest(request: cleaningV1.SubmitRequestRequest): Promise<cleaningV1.SubmitRequestResponse> {
    const record = await this.useCases.submit.execute({
      idempotencyKey: request.idempotencyKey,
      placeId: request.placeId,
      cleaningTypeIds: request.cleaningTypeIds,
      values: valuesFromProto(request.values),
      freeDescription: request.freeDescription,
      schedule: scheduleFromProto(request.schedule),
      visitSlots: request.visitSlots,
      comment: request.comment,
      photoFileIds: request.photoFileIds,
    });
    return this.view(record);
  }

  async listMyRequests(
    request: cleaningV1.ListMyRequestsRequest,
  ): Promise<cleaningV1.ListMyRequestsResponse> {
    const page = await this.useCases.requests.list(request);
    return {
      items: await this.presenter.summaries(page.items, CUSTOMER),
      nextCursor: page.nextCursor ?? '',
      total: page.total,
    };
  }

  async getMyRequest(request: cleaningV1.GetMyRequestRequest): Promise<cleaningV1.GetMyRequestResponse> {
    return this.view(await this.useCases.requests.get(request.requestId));
  }

  async payVisitFee(request: cleaningV1.PayVisitFeeRequest): Promise<cleaningV1.PayVisitFeeResponse> {
    const outcome = await this.useCases.requests.payVisitFee(request);
    return {
      paymentOutcome: {
        status: outcome.status,
        amount: money(outcome.amount),
        walletTransactionId: opt(outcome.walletTransactionId),
        paymentId: opt(outcome.paymentId),
        checkoutUrl: opt(outcome.checkoutUrl),
      },
    };
  }

  async changeVisitSlot(
    request: cleaningV1.ChangeVisitSlotRequest,
  ): Promise<cleaningV1.ChangeVisitSlotResponse> {
    return this.view(await this.useCases.requests.changeVisitSlot(request));
  }

  async cancelRequest(request: cleaningV1.CancelRequestRequest): Promise<cleaningV1.CancelRequestResponse> {
    return this.view(await this.useCases.requests.cancel(request));
  }

  async requestReactivation(
    request: cleaningV1.RequestReactivationRequest,
  ): Promise<cleaningV1.RequestReactivationResponse> {
    return this.view(await this.useCases.requests.requestReactivation(request));
  }

  async getMyQuote(request: cleaningV1.GetMyQuoteRequest): Promise<cleaningV1.GetMyQuoteResponse> {
    const { record, quote } = await this.useCases.quotes.get(request.quoteId);
    return { quote: await this.presenter.quoteView(record, quote, CUSTOMER) };
  }

  async acceptQuote(request: cleaningV1.AcceptQuoteRequest): Promise<cleaningV1.AcceptQuoteResponse> {
    const accepted = await this.useCases.quotes.accept(request);
    const fresh = await this.useCases.requests.get(accepted.record.request.id);
    const quote = fresh.quotes.find((item) => item.id === accepted.quote.id) ?? accepted.quote;
    return {
      acceptQuoteResult: {
        quote: await this.presenter.quoteView(fresh, quote, CUSTOMER),
        program: await this.presenter.program({ ...accepted, record: fresh }, CUSTOMER),
      },
    };
  }

  async declineQuote(request: cleaningV1.DeclineQuoteRequest): Promise<cleaningV1.DeclineQuoteResponse> {
    const { record, quote } = await this.useCases.quotes.decline(request);
    return { quote: await this.presenter.quoteView(record, quote, CUSTOMER) };
  }

  async forwardQuote(request: cleaningV1.ForwardQuoteRequest): Promise<cleaningV1.ForwardQuoteResponse> {
    const { record, quote } = await this.useCases.quotes.forward(request.quoteId);
    return { quote: await this.presenter.quoteView(record, quote, CUSTOMER) };
  }
}
