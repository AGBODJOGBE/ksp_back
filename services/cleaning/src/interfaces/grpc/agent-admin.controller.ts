import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC d'AgentAdminService — back-office : agents, disponibilités, équipes (UC-NT-34 à
 * 36). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore livrée répond
 * NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.AgentAdminServiceControllerMethods()
export class AgentAdminGrpcController implements cleaningV1.AgentAdminServiceController {
  listAgents(): Promise<cleaningV1.ListAgentsResponse> {
    return notImplemented('ListAgents');
  }

  getAgent(): Promise<cleaningV1.GetAgentResponse> {
    return notImplemented('GetAgent');
  }

  getAgentIdDocument(): Promise<cleaningV1.GetAgentIdDocumentResponse> {
    return notImplemented('GetAgentIdDocument');
  }

  createAgent(): Promise<cleaningV1.CreateAgentResponse> {
    return notImplemented('CreateAgent');
  }

  inviteAgent(): Promise<cleaningV1.InviteAgentResponse> {
    return notImplemented('InviteAgent');
  }

  updateAgent(): Promise<cleaningV1.UpdateAgentResponse> {
    return notImplemented('UpdateAgent');
  }

  startAgentReview(): Promise<cleaningV1.StartAgentReviewResponse> {
    return notImplemented('StartAgentReview');
  }

  approveAgent(): Promise<cleaningV1.ApproveAgentResponse> {
    return notImplemented('ApproveAgent');
  }

  rejectAgent(): Promise<cleaningV1.RejectAgentResponse> {
    return notImplemented('RejectAgent');
  }

  suspendAgent(): Promise<cleaningV1.SuspendAgentResponse> {
    return notImplemented('SuspendAgent');
  }

  reactivateAgent(): Promise<cleaningV1.ReactivateAgentResponse> {
    return notImplemented('ReactivateAgent');
  }

  deactivateAgent(): Promise<cleaningV1.DeactivateAgentResponse> {
    return notImplemented('DeactivateAgent');
  }

  getAgentAvailability(): Promise<cleaningV1.GetAgentAvailabilityResponse> {
    return notImplemented('GetAgentAvailability');
  }

  setAgentAvailability(): Promise<cleaningV1.SetAgentAvailabilityResponse> {
    return notImplemented('SetAgentAvailability');
  }

  declareAgentUnavailability(): Promise<cleaningV1.DeclareAgentUnavailabilityResponse> {
    return notImplemented('DeclareAgentUnavailability');
  }

  removeAgentUnavailability(): Promise<cleaningV1.RemoveAgentUnavailabilityResponse> {
    return notImplemented('RemoveAgentUnavailability');
  }

  listTeams(): Promise<cleaningV1.ListTeamsResponse> {
    return notImplemented('ListTeams');
  }

  createTeam(): Promise<cleaningV1.CreateTeamResponse> {
    return notImplemented('CreateTeam');
  }

  getTeam(): Promise<cleaningV1.GetTeamResponse> {
    return notImplemented('GetTeam');
  }

  updateTeam(): Promise<cleaningV1.UpdateTeamResponse> {
    return notImplemented('UpdateTeam');
  }
}
