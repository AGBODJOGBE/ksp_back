import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de RequestAdminService — back-office : demandes, visites, constat retenu, devis
 * (UC-NT-30 à 33). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore livrée répond
 * NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.RequestAdminServiceControllerMethods()
export class RequestAdminGrpcController implements cleaningV1.RequestAdminServiceController {
  listRequests(): Promise<cleaningV1.ListRequestsResponse> {
    return notImplemented('ListRequests');
  }

  getRequest(): Promise<cleaningV1.GetRequestResponse> {
    return notImplemented('GetRequest');
  }

  rejectRequest(): Promise<cleaningV1.RejectRequestResponse> {
    return notImplemented('RejectRequest');
  }

  correctRequestLocation(): Promise<cleaningV1.CorrectRequestLocationResponse> {
    return notImplemented('CorrectRequestLocation');
  }

  decideReactivation(): Promise<cleaningV1.DecideReactivationResponse> {
    return notImplemented('DecideReactivation');
  }

  listVisits(): Promise<cleaningV1.ListVisitsResponse> {
    return notImplemented('ListVisits');
  }

  scheduleVisit(): Promise<cleaningV1.ScheduleVisitResponse> {
    return notImplemented('ScheduleVisit');
  }

  updateVisit(): Promise<cleaningV1.UpdateVisitResponse> {
    return notImplemented('UpdateVisit');
  }

  cancelVisit(): Promise<cleaningV1.CancelVisitResponse> {
    return notImplemented('CancelVisit');
  }

  requestNewVisit(): Promise<cleaningV1.RequestNewVisitResponse> {
    return notImplemented('RequestNewVisit');
  }

  completeVisitOnBehalf(): Promise<cleaningV1.CompleteVisitOnBehalfResponse> {
    return notImplemented('CompleteVisitOnBehalf');
  }

  reportVisitMissedOnBehalf(): Promise<cleaningV1.ReportVisitMissedOnBehalfResponse> {
    return notImplemented('ReportVisitMissedOnBehalf');
  }

  removeVisitPhotoAsKsp(): Promise<cleaningV1.RemoveVisitPhotoAsKspResponse> {
    return notImplemented('RemoveVisitPhotoAsKsp');
  }

  saveRetainedValues(): Promise<cleaningV1.SaveRetainedValuesResponse> {
    return notImplemented('SaveRetainedValues');
  }

  estimateRetainedValues(): Promise<cleaningV1.EstimateRetainedValuesResponse> {
    return notImplemented('EstimateRetainedValues');
  }

  createQuote(): Promise<cleaningV1.CreateQuoteResponse> {
    return notImplemented('CreateQuote');
  }

  getQuote(): Promise<cleaningV1.GetQuoteResponse> {
    return notImplemented('GetQuote');
  }

  updateQuoteDraft(): Promise<cleaningV1.UpdateQuoteDraftResponse> {
    return notImplemented('UpdateQuoteDraft');
  }

  approveQuoteAdjustment(): Promise<cleaningV1.ApproveQuoteAdjustmentResponse> {
    return notImplemented('ApproveQuoteAdjustment');
  }

  sendQuote(): Promise<cleaningV1.SendQuoteResponse> {
    return notImplemented('SendQuote');
  }
}
