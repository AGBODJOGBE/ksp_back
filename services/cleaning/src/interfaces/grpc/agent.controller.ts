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
// Lot C
import { requireUser } from '@ksp/platform';
import { LOT_C_USE_CASES, type LotCUseCases } from '../../application/requests/lot-c-use-cases';
import { type CaseRecord } from '../../application/requests/requests.ports';
import { agentVisitAfter, presentAgentVisit } from './agent-visit.presenter';
import { declaredFromProto } from './case-values.presenters';
import { toAgentAssignmentPage, toAgentAssignmentView } from './planning-mappers';
// Lot E
import { AgentActivityUseCase } from '../../application/execution/agent-activity.use-cases';
import { FieldSessionUseCases } from '../../application/execution/field.use-cases';
import { type ExecutionDeps } from '../../application/deps';
import { presentActivity, presentAgentSession } from './execution-presenters';

/**
 * Adaptateur gRPC d'AgentService — application agent : inscription, disponibilités, planning,
 * visites et séances (UC-NT-19 à 24). Lot D livré : inscription, profil, disponibilités, mon
 * planning, réponse aux affectations. Lot C livré : visites des lieux sur le terrain. Lot E livré :
 * séances sur le terrain et mon activité (séances réalisées).
 */
@Controller()
@cleaningV1.AgentServiceControllerMethods()
export class AgentGrpcController implements cleaningV1.AgentServiceController {
  private readonly submit: SubmitAgentApplicationUseCase;
  private readonly profile: GetMyAgentProfileUseCase;
  private readonly availability: AvailabilityUseCases;
  private readonly assignments: AgentAssignmentUseCases;
  // Lot E : séance sur le terrain et mon activité.
  private readonly field: FieldSessionUseCases;
  private readonly activity: AgentActivityUseCase;

  constructor(
    @Inject(CLEANING_DEPS) private readonly deps: CleaningDeps,
    // Lot C
    @Inject(LOT_C_USE_CASES) private readonly lotC: LotCUseCases,
  ) {
    this.submit = new SubmitAgentApplicationUseCase(deps);
    this.profile = new GetMyAgentProfileUseCase(deps);
    this.availability = new AvailabilityUseCases(deps);
    this.assignments = new AgentAssignmentUseCases(deps);
    // Lot E
    this.field = new FieldSessionUseCases(deps as ExecutionDeps);
    this.activity = new AgentActivityUseCase(deps as ExecutionDeps);
  }

  async submitAgentApplication(
    request: cleaningV1.SubmitAgentApplicationRequest,
  ): Promise<cleaningV1.SubmitAgentApplicationResponse> {
    return { agent: toAgent(await this.submit.execute(request)) };
  }

  async getMyAgentProfile(): Promise<cleaningV1.GetMyAgentProfileResponse> {
    return { agent: toAgent(await this.profile.execute()) };
  }

  async getMyActivity(): Promise<cleaningV1.GetMyActivityResponse> {
    return { agentActivity: presentActivity(await this.activity.execute()) };
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

  // --- Lot C : visite des lieux côté terrain (UC-NT-22) ---

  /** Chef de la visite : affectation en vigueur marquée chef pour le compte connecté. */
  private async isLead(visitId: string): Promise<boolean> {
    const userId = requireUser().userId;
    const agent = await this.deps.planning.agentByUserId(userId);
    const [target] = await this.deps.planning.targets([{ kind: 'visit', id: visitId }]);
    return (target?.assignments ?? []).some((item) => item.agentId === agent?.id && item.isLead);
  }

  private async visitView(record: CaseRecord, visitId: string) {
    return { agentVisitView: await agentVisitAfter(this.deps, record, visitId, await this.isLead(visitId)) };
  }

  async getAgentVisit(request: cleaningV1.GetAgentVisitRequest): Promise<cleaningV1.GetAgentVisitResponse> {
    const view = await this.lotC.agentVisits.get(request.visitId);
    return {
      agentVisitView: await presentAgentVisit(this.deps, {
        ...view,
        isLead: await this.isLead(view.visit.id),
      }),
    };
  }

  async arriveAtVisit(request: cleaningV1.ArriveAtVisitRequest): Promise<cleaningV1.ArriveAtVisitResponse> {
    const record = await this.lotC.agentVisits.arrive({
      visitId: request.visitId,
      idempotencyKey: request.idempotencyKey,
      latitude: request.latitude,
      longitude: request.longitude,
      accuracyMeters: request.accuracyMeters,
      occurredAt: request.occurredAt,
    });
    return this.visitView(record, request.visitId);
  }

  async saveVisitObservations(
    request: cleaningV1.SaveVisitObservationsRequest,
  ): Promise<cleaningV1.SaveVisitObservationsResponse> {
    const record = await this.lotC.agentVisits.saveObservations({
      visitId: request.visitId,
      idempotencyKey: request.idempotencyKey,
      values: declaredFromProto(request.values),
      note: request.note,
      occurredAt: request.occurredAt,
    });
    return this.visitView(record, request.visitId);
  }

  async addVisitPhoto(request: cleaningV1.AddVisitPhotoRequest): Promise<cleaningV1.AddVisitPhotoResponse> {
    const record = await this.lotC.agentVisits.addPhoto({
      visitId: request.visitId,
      idempotencyKey: request.idempotencyKey,
      fileId: request.fileId,
      occurredAt: request.occurredAt,
    });
    return this.visitView(record, request.visitId);
  }

  async completeVisit(request: cleaningV1.CompleteVisitRequest): Promise<cleaningV1.CompleteVisitResponse> {
    const record = await this.lotC.agentVisits.complete({
      visitId: request.visitId,
      idempotencyKey: request.idempotencyKey,
      occurredAt: request.occurredAt,
    });
    return this.visitView(record, request.visitId);
  }

  async reportVisitMissed(
    request: cleaningV1.ReportVisitMissedRequest,
  ): Promise<cleaningV1.ReportVisitMissedResponse> {
    const record = await this.lotC.agentVisits.reportMissed({
      visitId: request.visitId,
      idempotencyKey: request.idempotencyKey,
      photoFileId: request.photoFileId,
      occurredAt: request.occurredAt,
    });
    return this.visitView(record, request.visitId);
  }

  async removeVisitPhoto(
    request: cleaningV1.RemoveVisitPhotoRequest,
  ): Promise<cleaningV1.RemoveVisitPhotoResponse> {
    const record = await this.lotC.agentVisits.removePhoto({
      visitId: request.visitId,
      fileId: request.fileId,
      idempotencyKey: request.idempotencyKey,
    });
    return this.visitView(record, request.visitId);
  }

  async getAgentSession(
    request: cleaningV1.GetAgentSessionRequest,
  ): Promise<cleaningV1.GetAgentSessionResponse> {
    return { agentSessionView: presentAgentSession(await this.field.get(request.sessionId)) };
  }

  async arriveAtSession(
    request: cleaningV1.ArriveAtSessionRequest,
  ): Promise<cleaningV1.ArriveAtSessionResponse> {
    return { agentSessionView: presentAgentSession(await this.field.arrive(request)) };
  }

  async startSession(request: cleaningV1.StartSessionRequest): Promise<cleaningV1.StartSessionResponse> {
    return { agentSessionView: presentAgentSession(await this.field.start(request)) };
  }

  async updateSessionChecklist(
    request: cleaningV1.UpdateSessionChecklistRequest,
  ): Promise<cleaningV1.UpdateSessionChecklistResponse> {
    return { agentSessionView: presentAgentSession(await this.field.updateChecklist(request)) };
  }

  async addSessionPhoto(
    request: cleaningV1.AddSessionPhotoRequest,
  ): Promise<cleaningV1.AddSessionPhotoResponse> {
    return { agentSessionView: presentAgentSession(await this.field.addPhoto(request)) };
  }

  async reportSessionIncident(
    request: cleaningV1.ReportSessionIncidentRequest,
  ): Promise<cleaningV1.ReportSessionIncidentResponse> {
    return { agentSessionView: presentAgentSession(await this.field.reportIncident(request)) };
  }

  async completeSession(
    request: cleaningV1.CompleteSessionRequest,
  ): Promise<cleaningV1.CompleteSessionResponse> {
    return { agentSessionView: presentAgentSession(await this.field.complete(request)) };
  }

  async reportSessionMissed(
    request: cleaningV1.ReportSessionMissedRequest,
  ): Promise<cleaningV1.ReportSessionMissedResponse> {
    return { agentSessionView: presentAgentSession(await this.field.reportMissed(request)) };
  }

  async removeSessionPhoto(
    request: cleaningV1.RemoveSessionPhotoRequest,
  ): Promise<cleaningV1.RemoveSessionPhotoResponse> {
    return { agentSessionView: presentAgentSession(await this.field.removePhoto(request)) };
  }
}
