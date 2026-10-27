import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { parsePage } from '../../application/shared/validation';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';
import { type PriceLine } from '../../domain/simulator';
import {
  presentAgent,
  presentDefinition,
  presentMission,
  presentRequest,
  presentSettings,
  presentTeam,
  presentZone,
} from './presenters';

const amount = (value: { amount: number } | undefined) => (value ? value.amount : null);

function toLine(line: cleaningV1.PriceLine): PriceLine {
  return {
    label: line.label,
    quantity: line.quantity,
    unitPrice: line.unitPrice?.amount ?? 0,
    amount: line.amount?.amount ?? 0,
  };
}

/** Adaptateur gRPC du back-office Nettoyage (UC-CL-06 à 12). Les droits sont vérifiés par chaque cas d'usage. */
@Controller()
@cleaningV1.CleaningAdminServiceControllerMethods()
export class CleaningAdminGrpcController implements cleaningV1.CleaningAdminServiceController {
  constructor(@Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases) {}

  // --- Demandes, visites, devis -------------------------------------------------------------

  async listQuoteRequests(
    request: cleaningV1.ListQuoteRequestsRequest,
  ): Promise<cleaningV1.ListQuoteRequestsResponse> {
    const page = await this.useCases.listQuoteRequests.execute({
      page: parsePage(request.page),
      status: request.status,
    });
    return { requests: page.items.map(presentRequest), nextCursor: page.nextCursor ?? '' };
  }

  async getQuoteRequest(
    request: cleaningV1.GetQuoteRequestRequest,
  ): Promise<cleaningV1.GetQuoteRequestResponse> {
    return { request: presentRequest(await this.useCases.getQuoteRequest.execute(request.requestId)) };
  }

  async rejectQuoteRequest(
    request: cleaningV1.RejectQuoteRequestRequest,
  ): Promise<cleaningV1.RejectQuoteRequestResponse> {
    return { request: presentRequest(await this.useCases.rejectQuoteRequest.execute(request)) };
  }

  async scheduleVisit(request: cleaningV1.ScheduleVisitRequest): Promise<cleaningV1.ScheduleVisitResponse> {
    return { request: presentRequest(await this.useCases.scheduleVisit.execute(request)) };
  }

  async completeVisit(request: cleaningV1.CompleteVisitRequest): Promise<cleaningV1.CompleteVisitResponse> {
    return { request: presentRequest(await this.useCases.completeVisit.execute(request)) };
  }

  async sendQuote(request: cleaningV1.SendQuoteRequest): Promise<cleaningV1.SendQuoteResponse> {
    const result = await this.useCases.sendQuote.execute({ ...request, lines: request.lines.map(toLine) });
    return { request: presentRequest(result) };
  }

  // --- Missions et passages ------------------------------------------------------------------

  async listMissions(request: cleaningV1.ListMissionsRequest): Promise<cleaningV1.ListMissionsResponse> {
    const page = await this.useCases.listMissions.execute({
      page: parsePage(request.page),
      status: request.status,
    });
    return { missions: page.items.map(presentMission), nextCursor: page.nextCursor ?? '' };
  }

  async getMissionDetail(
    request: cleaningV1.GetMissionDetailRequest,
  ): Promise<cleaningV1.GetMissionDetailResponse> {
    return { mission: presentMission(await this.useCases.getMissionDetail.execute(request.missionId)) };
  }

  async scheduleIntervention(
    request: cleaningV1.ScheduleInterventionRequest,
  ): Promise<cleaningV1.ScheduleInterventionResponse> {
    return { mission: presentMission(await this.useCases.scheduleIntervention.execute(request)) };
  }

  async startIntervention(
    request: cleaningV1.StartInterventionRequest,
  ): Promise<cleaningV1.StartInterventionResponse> {
    return { mission: presentMission(await this.useCases.startIntervention.execute(request.interventionId)) };
  }

  async updateChecklist(
    request: cleaningV1.UpdateChecklistRequest,
  ): Promise<cleaningV1.UpdateChecklistResponse> {
    return { mission: presentMission(await this.useCases.updateChecklist.execute(request)) };
  }

  async reportIncident(
    request: cleaningV1.ReportIncidentRequest,
  ): Promise<cleaningV1.ReportIncidentResponse> {
    return { mission: presentMission(await this.useCases.reportIncident.execute(request)) };
  }

  async resumeIntervention(
    request: cleaningV1.ResumeInterventionRequest,
  ): Promise<cleaningV1.ResumeInterventionResponse> {
    return {
      mission: presentMission(await this.useCases.resumeIntervention.execute(request.interventionId)),
    };
  }

  async completeIntervention(
    request: cleaningV1.CompleteInterventionRequest,
  ): Promise<cleaningV1.CompleteInterventionResponse> {
    return {
      mission: presentMission(await this.useCases.completeIntervention.execute(request.interventionId)),
    };
  }

  async recordPayment(request: cleaningV1.RecordPaymentRequest): Promise<cleaningV1.RecordPaymentResponse> {
    const result = await this.useCases.recordPayment.execute({
      missionId: request.missionId,
      amount: request.amount?.amount ?? 0,
      method: request.method,
      reference: request.reference,
    });
    return { mission: presentMission(result) };
  }

  async cancelMissionAsSupervisor(
    request: cleaningV1.CancelMissionAsSupervisorRequest,
  ): Promise<cleaningV1.CancelMissionAsSupervisorResponse> {
    return { mission: presentMission(await this.useCases.cancelMissionAsSupervisor.execute(request)) };
  }

  // --- Catalogue, grille, réglages -----------------------------------------------------------

  async getCatalog(): Promise<cleaningV1.GetCatalogResponse> {
    const { services, settings } = await this.useCases.getCatalog.execute();
    return { services: services.map(presentDefinition), settings: presentSettings(settings) };
  }

  async saveService(request: cleaningV1.SaveServiceRequest): Promise<cleaningV1.SaveServiceResponse> {
    const service = request.service;
    const pricing = service?.pricing;
    const saved = await this.useCases.saveService.execute({
      code: service?.code ?? '',
      name: service?.name ?? '',
      description: service?.description ?? '',
      unit: service?.unit ?? '',
      active: service?.active ?? false,
      pricing: {
        unitPrice: amount(pricing?.unitPrice),
        minimumPrice: amount(pricing?.minimumPrice),
        options: (pricing?.options ?? []).map((o) => ({
          code: o.code,
          label: o.label,
          price: amount(o.price),
        })),
        communeCoefficients: pricing?.communeCoefficients ?? [],
        defaultCoefficientBp: pricing?.defaultCoefficientBp ?? 0,
        teamSize: pricing?.teamSize ?? null,
        checklist: (pricing?.checklist ?? []).map((item) => ({ code: item.code, label: item.label })),
      },
    });
    return { service: presentDefinition(saved) };
  }

  async updateSettings(
    request: cleaningV1.UpdateSettingsRequest,
  ): Promise<cleaningV1.UpdateSettingsResponse> {
    const s = request.settings;
    const saved = await this.useCases.updateSettings.execute({
      quoteValidityDays: s?.quoteValidityDays ?? 0,
      minimumLeadHours: s?.minimumLeadHours ?? -1,
      freeCancellationHours: s?.freeCancellationHours ?? -1,
      visitThresholdSquareMeters: s?.visitThresholdSquareMeters ?? 0,
      maxOpenRequests: s?.maxOpenRequests ?? 0,
      depositPercent: s?.depositPercent ?? -1,
      // 0 : valeur en vigueur conservée (réglages de la partie 10).
      businessWarningUnpaidInvoices: s?.businessWarningUnpaidInvoices ?? 0,
      businessSuspensionUnpaidInvoices: s?.businessSuspensionUnpaidInvoices ?? 0,
      individualSuspensionUnpaidInterventions: s?.individualSuspensionUnpaidInterventions ?? 0,
      individualPaymentGraceHours: s?.individualPaymentGraceHours ?? 0,
    });
    return { settings: presentSettings(saved) };
  }

  // --- Zones desservies ----------------------------------------------------------------------

  async listZones(): Promise<cleaningV1.ListZonesResponse> {
    return { zones: (await this.useCases.listZones.execute()).map(presentZone) };
  }

  async saveZone(request: cleaningV1.SaveZoneRequest): Promise<cleaningV1.SaveZoneResponse> {
    return { zone: presentZone(await this.useCases.saveZone.execute({ commune: request.commune })) };
  }

  async deactivateZone(
    request: cleaningV1.DeactivateZoneRequest,
  ): Promise<cleaningV1.DeactivateZoneResponse> {
    return { zone: presentZone(await this.useCases.deactivateZone.execute({ code: request.code })) };
  }

  // --- Agents et équipes ---------------------------------------------------------------------

  async listAgents(): Promise<cleaningV1.ListAgentsResponse> {
    return { agents: (await this.useCases.listAgents.execute()).map(presentAgent) };
  }

  async registerAgent(request: cleaningV1.RegisterAgentRequest): Promise<cleaningV1.RegisterAgentResponse> {
    return { agent: presentAgent(await this.useCases.registerAgent.execute(request)) };
  }

  async declareUnavailability(
    request: cleaningV1.DeclareUnavailabilityRequest,
  ): Promise<cleaningV1.DeclareUnavailabilityResponse> {
    return { agent: presentAgent(await this.useCases.declareUnavailability.execute(request)) };
  }

  async listTeams(): Promise<cleaningV1.ListTeamsResponse> {
    const [teams, agents] = await Promise.all([
      this.useCases.listTeams.execute(),
      this.useCases.listAgents.execute(),
    ]);
    return { teams: teams.map((team) => presentTeam(team, agents)) };
  }

  async createTeam(request: cleaningV1.CreateTeamRequest): Promise<cleaningV1.CreateTeamResponse> {
    const team = await this.useCases.createTeam.execute(request);
    return { team: presentTeam(team, await this.useCases.listAgents.execute()) };
  }

  async updateTeam(request: cleaningV1.UpdateTeamRequest): Promise<cleaningV1.UpdateTeamResponse> {
    const team = await this.useCases.updateTeam.execute(request);
    return { team: presentTeam(team, await this.useCases.listAgents.execute()) };
  }
}
