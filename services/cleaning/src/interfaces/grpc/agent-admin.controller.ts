import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import {
  type AgentAction,
  ChangeAgentStatusUseCase,
  GetAgentUseCase,
  ListAgentsUseCase,
  UpdateAgentUseCase,
} from '../../application/agents/agent-admin.use-cases';
import { CreateAgentUseCase } from '../../application/agents/agent-creation.use-case';
import { GetAgentIdDocumentUseCase } from '../../application/agents/agent-id-document.use-case';
import { InviteAgentUseCase } from '../../application/agents/agent-invitation.use-case';
import { AvailabilityUseCases } from '../../application/agents/availability.use-cases';
import { TeamUseCases } from '../../application/agents/team.use-cases';
import { type AgentDeps, CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import { toAgent, toAgentPage, toAvailability, toIdDocument, toTeam } from './agent-mappers';

/**
 * Adaptateur gRPC d'AgentAdminService — back-office : agents, disponibilités, équipes (UC-NT-34 à
 * 36, lot D) ; pièce d'identité d'un agent, création d'un agent par l'admin (compte trouvé ou créé
 * par son téléphone chez identity) et invitation d'un agent, envoyée par notification (piste A).
 */
@Controller()
@cleaningV1.AgentAdminServiceControllerMethods()
export class AgentAdminGrpcController implements cleaningV1.AgentAdminServiceController {
  private readonly list: ListAgentsUseCase;
  private readonly get: GetAgentUseCase;
  private readonly update: UpdateAgentUseCase;
  private readonly status: ChangeAgentStatusUseCase;
  private readonly availability: AvailabilityUseCases;
  private readonly teams: TeamUseCases;
  // Piste A (agents)
  private readonly idDocument: GetAgentIdDocumentUseCase;
  private readonly create: CreateAgentUseCase;
  private readonly invite: InviteAgentUseCase;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.list = new ListAgentsUseCase(deps);
    this.get = new GetAgentUseCase(deps);
    this.update = new UpdateAgentUseCase(deps);
    this.status = new ChangeAgentStatusUseCase(deps as AgentDeps);
    this.availability = new AvailabilityUseCases(deps);
    this.teams = new TeamUseCases(deps);
    // Piste A (agents)
    this.idDocument = new GetAgentIdDocumentUseCase(deps);
    this.create = new CreateAgentUseCase(deps as AgentDeps);
    this.invite = new InviteAgentUseCase(deps as AgentDeps);
  }

  async listAgents(request: cleaningV1.ListAgentsRequest): Promise<cleaningV1.ListAgentsResponse> {
    return toAgentPage(await this.list.execute(request));
  }

  async getAgent(request: cleaningV1.GetAgentRequest): Promise<cleaningV1.GetAgentResponse> {
    return { agent: toAgent(await this.get.execute(request.agentId)) };
  }

  async getAgentIdDocument(
    request: cleaningV1.GetAgentIdDocumentRequest,
  ): Promise<cleaningV1.GetAgentIdDocumentResponse> {
    return { idDocument: toIdDocument(await this.idDocument.execute(request.agentId)) };
  }

  async createAgent(request: cleaningV1.CreateAgentRequest): Promise<cleaningV1.CreateAgentResponse> {
    return { agent: toAgent(await this.create.execute(request)) };
  }

  async inviteAgent(request: cleaningV1.InviteAgentRequest): Promise<cleaningV1.InviteAgentResponse> {
    const invitation = await this.invite.execute(request);
    return {
      agentInvitation: {
        id: invitation.id,
        phone: invitation.phone,
        expiresAt: invitation.expiresAt.toISOString(),
      },
    };
  }

  async updateAgent(request: cleaningV1.UpdateAgentRequest): Promise<cleaningV1.UpdateAgentResponse> {
    const profile = await this.update.execute({
      agentId: request.agentId,
      zoneKeys: request.zoneKeys?.items ?? null,
      validatedSkillCodes: request.validatedSkillCodes?.items ?? null,
      maxHoursPerDay: request.maxHoursPerDay ?? null,
      maxHoursPerWeek: request.maxHoursPerWeek ?? null,
      employmentKind: request.employmentKind ?? null,
      residenceCommuneKey: request.residenceCommuneKey ?? null,
      emergencyContact: request.emergencyContact ?? null,
    });
    return { agent: toAgent(profile) };
  }

  private async change(
    action: AgentAction,
    request: {
      agentId: string;
      idempotencyKey: string;
      reason?: string;
      reassign?: boolean;
      validatedSkillCodes?: string[];
    },
  ): Promise<{ agent: cleaningV1.Agent }> {
    return { agent: toAgent(await this.status.execute({ action, ...request })) };
  }

  startAgentReview(
    request: cleaningV1.StartAgentReviewRequest,
  ): Promise<cleaningV1.StartAgentReviewResponse> {
    return this.change('review', request);
  }

  approveAgent(request: cleaningV1.ApproveAgentRequest): Promise<cleaningV1.ApproveAgentResponse> {
    return this.change('approve', request);
  }

  rejectAgent(request: cleaningV1.RejectAgentRequest): Promise<cleaningV1.RejectAgentResponse> {
    return this.change('reject', request);
  }

  suspendAgent(request: cleaningV1.SuspendAgentRequest): Promise<cleaningV1.SuspendAgentResponse> {
    return this.change('suspend', request);
  }

  reactivateAgent(request: cleaningV1.ReactivateAgentRequest): Promise<cleaningV1.ReactivateAgentResponse> {
    return this.change('reactivate', request);
  }

  deactivateAgent(request: cleaningV1.DeactivateAgentRequest): Promise<cleaningV1.DeactivateAgentResponse> {
    return this.change('deactivate', request);
  }

  async getAgentAvailability(
    request: cleaningV1.GetAgentAvailabilityRequest,
  ): Promise<cleaningV1.GetAgentAvailabilityResponse> {
    return { availability: toAvailability(await this.availability.getFor(request.agentId)) };
  }

  async setAgentAvailability(
    request: cleaningV1.SetAgentAvailabilityRequest,
  ): Promise<cleaningV1.SetAgentAvailabilityResponse> {
    return { availability: toAvailability(await this.availability.setFor(request)) };
  }

  async declareAgentUnavailability(
    request: cleaningV1.DeclareAgentUnavailabilityRequest,
  ): Promise<cleaningV1.DeclareAgentUnavailabilityResponse> {
    return { availability: toAvailability(await this.availability.declareFor(request)) };
  }

  async removeAgentUnavailability(
    request: cleaningV1.RemoveAgentUnavailabilityRequest,
  ): Promise<cleaningV1.RemoveAgentUnavailabilityResponse> {
    return {
      availability: toAvailability(
        await this.availability.removeFor(request.agentId, request.unavailabilityId),
      ),
    };
  }

  async listTeams(request: cleaningV1.ListTeamsRequest): Promise<cleaningV1.ListTeamsResponse> {
    const page = await this.teams.list(request);
    return { items: page.items.map(toTeam), nextCursor: page.nextCursor ?? '', total: page.total };
  }

  async createTeam(request: cleaningV1.CreateTeamRequest): Promise<cleaningV1.CreateTeamResponse> {
    return { team: toTeam(await this.teams.create(request)) };
  }

  async getTeam(request: cleaningV1.GetTeamRequest): Promise<cleaningV1.GetTeamResponse> {
    return { team: toTeam(await this.teams.get(request.teamId)) };
  }

  async updateTeam(request: cleaningV1.UpdateTeamRequest): Promise<cleaningV1.UpdateTeamResponse> {
    const team = await this.teams.update({
      teamId: request.teamId,
      name: request.name ?? null,
      leadAgentId: request.leadAgentId ?? null,
      memberIds: request.memberIds?.items ?? null,
      active: request.active ?? null,
    });
    return { team: toTeam(team) };
  }
}
