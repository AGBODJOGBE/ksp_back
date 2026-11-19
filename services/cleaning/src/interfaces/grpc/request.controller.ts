import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de RequestService — demandes de devis, frais de visite, devis du client (UC-NT-04
 * à 10). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore livrée répond
 * NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.RequestServiceControllerMethods()
export class RequestGrpcController implements cleaningV1.RequestServiceController {
  submitRequest(): Promise<cleaningV1.SubmitRequestResponse> {
    return notImplemented('SubmitRequest');
  }

  listMyRequests(): Promise<cleaningV1.ListMyRequestsResponse> {
    return notImplemented('ListMyRequests');
  }

  getMyRequest(): Promise<cleaningV1.GetMyRequestResponse> {
    return notImplemented('GetMyRequest');
  }

  payVisitFee(): Promise<cleaningV1.PayVisitFeeResponse> {
    return notImplemented('PayVisitFee');
  }

  changeVisitSlot(): Promise<cleaningV1.ChangeVisitSlotResponse> {
    return notImplemented('ChangeVisitSlot');
  }

  cancelRequest(): Promise<cleaningV1.CancelRequestResponse> {
    return notImplemented('CancelRequest');
  }

  requestReactivation(): Promise<cleaningV1.RequestReactivationResponse> {
    return notImplemented('RequestReactivation');
  }

  getMyQuote(): Promise<cleaningV1.GetMyQuoteResponse> {
    return notImplemented('GetMyQuote');
  }

  acceptQuote(): Promise<cleaningV1.AcceptQuoteResponse> {
    return notImplemented('AcceptQuote');
  }

  declineQuote(): Promise<cleaningV1.DeclineQuoteResponse> {
    return notImplemented('DeclineQuote');
  }

  forwardQuote(): Promise<cleaningV1.ForwardQuoteResponse> {
    return notImplemented('ForwardQuote');
  }
}
