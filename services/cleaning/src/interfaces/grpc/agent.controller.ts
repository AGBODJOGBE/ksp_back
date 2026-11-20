import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import {
  GetMyAgentProfileUseCase,
  SubmitAgentApplicationUseCase,
} from '../../application/agents/agent-registration.use-cases';
import { AvailabilityUseCases } from '../../application/agents/availability.use-cases';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import { AgentAssignmentUseCases } from '../../application/planning/agent-assignments.use-cases';
import { toAgent, toAvailability } from './agent-mappers';
import { notImplemented } from './not-implemented';
import { toAgentAssignmentPage, toAgentAssignmentView } from './planning-mappers';

/**
 * Adaptateur gRPC d'AgentService — application agent : inscription, disponibilités, planning,
 * visites et séances (UC-NT-19 à 24). Lot D livré : inscription, profil, disponibilités, mon
 * planning, réponse aux affectations. Mon activité (séances réalisées) et le terrain (visites,
 * séances) arrivent avec les lots C et E et répondent encore NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.AgentServiceControllerMethods()
export class AgentGrpcController implements cleaningV1.AgentServiceController {
  private readonly submit: SubmitAgentApplicationUseCase;
  private readonly profile: GetMyAgentProfileUseCase;
  private readonly availability: AvailabilityUseCases;
  private readonly assignments: AgentAssignmentUseCases;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.submit = new SubmitAgentApplicationUseCase(deps);
    this.profile = new GetMyAgentProfileUseCase(deps);
    this.availability = new AvailabilityUseCases(deps);
    this.assignments = new AgentAssignmentUseCases(deps);
  }

  async submitAgentApplication(
    request: cleaningV1.SubmitAgentApplicationRequest,
  ): Promise<cleaningV1.SubmitAgentApplicationResponse> {
    return { agent: toAgent(await this.submit.execute(request)) };
  }

  async getMyAgentProfile(): Promise<cleaningV1.GetMyAgentProfileResponse> {
    return { agent: toAgent(await this.profile.execute()) };
  }

  getMyActivity(): Promise<cleaningV1.GetMyActivityResponse> {
    return notImplemented('GetMyActivity');
  }

  async getMyAvailability(): Promise<cleaningV1.GetMyAvailabilityResponse> {
    return { availability: toAvailability(await this.availability.getMine()) };
  }

  async setMyAvailability(
    request: cleaningV1.SetMyAvailabilityRequest,
  ): Promise<cleaningV1.SetMyAvailabilityResponse> {
    return { availability: toAvailability(await this.availability.setMine(request)) };
  }

  async declareMyUnavailability(
    request: cleaningV1.DeclareMyUnavailabilityRequest,
  ): Promise<cleaningV1.DeclareMyUnavailabilityResponse> {
    return { availability: toAvailability(await this.availability.declareMine(request)) };
  }

  async removeMyUnavailability(
    request: cleaningV1.RemoveMyUnavailabilityRequest,
  ): Promise<cleaningV1.RemoveMyUnavailabilityResponse> {
    return { availability: toAvailability(await this.availability.removeMine(request.unavailabilityId)) };
  }

  async listMyAssignments(
    request: cleaningV1.ListMyAssignmentsRequest,
  ): Promise<cleaningV1.ListMyAssignmentsResponse> {
    return toAgentAssignmentPage(await this.assignments.list(request));
  }

  async acceptAssignment(
    request: cleaningV1.AcceptAssignmentRequest,
  ): Promise<cleaningV1.AcceptAssignmentResponse> {
    const view = await this.assignments.respond({ ...request, answer: 'accept' });
    return { agentAssignmentView: toAgentAssignmentView(view) };
  }

  async declineAssignment(
    request: cleaningV1.DeclineAssignmentRequest,
  ): Promise<cleaningV1.DeclineAssignmentResponse> {
    const view = await this.assignments.respond({ ...request, answer: 'decline' });
    return { agentAssignmentView: toAgentAssignmentView(view) };
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
