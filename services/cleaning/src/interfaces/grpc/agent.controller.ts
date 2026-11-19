import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC d'AgentService — application agent : inscription, disponibilités, planning,
 * visites et séances (UC-NT-19 à 24). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas
 * encore livrée répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.AgentServiceControllerMethods()
export class AgentGrpcController implements cleaningV1.AgentServiceController {
  submitAgentApplication(): Promise<cleaningV1.SubmitAgentApplicationResponse> {
    return notImplemented('SubmitAgentApplication');
  }

  getMyAgentProfile(): Promise<cleaningV1.GetMyAgentProfileResponse> {
    return notImplemented('GetMyAgentProfile');
  }

  getMyActivity(): Promise<cleaningV1.GetMyActivityResponse> {
    return notImplemented('GetMyActivity');
  }

  getMyAvailability(): Promise<cleaningV1.GetMyAvailabilityResponse> {
    return notImplemented('GetMyAvailability');
  }

  setMyAvailability(): Promise<cleaningV1.SetMyAvailabilityResponse> {
    return notImplemented('SetMyAvailability');
  }

  declareMyUnavailability(): Promise<cleaningV1.DeclareMyUnavailabilityResponse> {
    return notImplemented('DeclareMyUnavailability');
  }

  removeMyUnavailability(): Promise<cleaningV1.RemoveMyUnavailabilityResponse> {
    return notImplemented('RemoveMyUnavailability');
  }

  listMyAssignments(): Promise<cleaningV1.ListMyAssignmentsResponse> {
    return notImplemented('ListMyAssignments');
  }

  acceptAssignment(): Promise<cleaningV1.AcceptAssignmentResponse> {
    return notImplemented('AcceptAssignment');
  }

  declineAssignment(): Promise<cleaningV1.DeclineAssignmentResponse> {
    return notImplemented('DeclineAssignment');
  }

  getAgentVisit(): Promise<cleaningV1.GetAgentVisitResponse> {
    return notImplemented('GetAgentVisit');
  }

  arriveAtVisit(): Promise<cleaningV1.ArriveAtVisitResponse> {
    return notImplemented('ArriveAtVisit');
  }

  saveVisitObservations(): Promise<cleaningV1.SaveVisitObservationsResponse> {
    return notImplemented('SaveVisitObservations');
  }

  addVisitPhoto(): Promise<cleaningV1.AddVisitPhotoResponse> {
    return notImplemented('AddVisitPhoto');
  }

  completeVisit(): Promise<cleaningV1.CompleteVisitResponse> {
    return notImplemented('CompleteVisit');
  }

  reportVisitMissed(): Promise<cleaningV1.ReportVisitMissedResponse> {
    return notImplemented('ReportVisitMissed');
  }

  removeVisitPhoto(): Promise<cleaningV1.RemoveVisitPhotoResponse> {
    return notImplemented('RemoveVisitPhoto');
  }

  getAgentSession(): Promise<cleaningV1.GetAgentSessionResponse> {
    return notImplemented('GetAgentSession');
  }

  arriveAtSession(): Promise<cleaningV1.ArriveAtSessionResponse> {
    return notImplemented('ArriveAtSession');
  }

  startSession(): Promise<cleaningV1.StartSessionResponse> {
    return notImplemented('StartSession');
  }

  updateSessionChecklist(): Promise<cleaningV1.UpdateSessionChecklistResponse> {
    return notImplemented('UpdateSessionChecklist');
  }

  addSessionPhoto(): Promise<cleaningV1.AddSessionPhotoResponse> {
    return notImplemented('AddSessionPhoto');
  }

  reportSessionIncident(): Promise<cleaningV1.ReportSessionIncidentResponse> {
    return notImplemented('ReportSessionIncident');
  }

  completeSession(): Promise<cleaningV1.CompleteSessionResponse> {
    return notImplemented('CompleteSession');
  }

  reportSessionMissed(): Promise<cleaningV1.ReportSessionMissedResponse> {
    return notImplemented('ReportSessionMissed');
  }

  removeSessionPhoto(): Promise<cleaningV1.RemoveSessionPhotoResponse> {
    return notImplemented('RemoveSessionPhoto');
  }
}
