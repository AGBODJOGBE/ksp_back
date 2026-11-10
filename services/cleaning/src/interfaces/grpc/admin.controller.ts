import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { type MissionView } from '../../application/deps';
import { type StoredSettings } from '../../application/ports';
import { parsePage } from '../../application/shared/validation';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';
import { type ServiceDefinition } from '../../domain/catalog';
import { type QuoteRequest } from '../../domain/quote-request';
import { type PriceLine } from '../../domain/simulator';
import { type ZoneView } from '../../application/catalog/zones.use-cases';
import { type MeasurementInput } from '../../application/requests/measurements.use-cases';
import {
  presentAgent,
  presentDefinition,
  presentMission,
  presentOutcome,
  presentPlaceType,
  presentRequest,
  presentSettings,
  presentSibling,
  presentTeam,
  presentVisit,
  presentZone,
} from './presenters';
import { presentAssignment, presentPhoto } from './complement.presenters';
import {
  answersFromProto,
  calculationToProto,
  definitionFromProto,
  selectionsFromProto,
} from './form.presenters';

/** Mesures reçues (ADR-037) : réponses absentes = non fournies, refusées par cleaning. */
function measurementFromProto(input: {
  answers?: cleaningV1.AnswerSet | undefined;
  optionSelections: cleaningV1.OptionSelection[];
  frequency: string;
}): MeasurementInput {
  return {
    answers: input.answers ? answersFromProto(input.answers) : undefined,
    optionSelections: selectionsFromProto(input.optionSelections),
    frequency: input.frequency,
  };
}

function toLine(line: cleaningV1.PriceLine): PriceLine {
  return {
    label: line.label,
    quantity: line.quantity,
    unitPrice: line.unitPrice?.amount ?? 0,
    amount: line.amount?.amount ?? 0,
  };
}

/**
 * Adaptateur gRPC du back-office Nettoyage (UC-CL-06 à 12). Les droits sont vérifiés par chaque
 * cas d'usage ; chaque réponse est complétée des noms affichés (ADR-029).
 */
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
      commune: request.commune,
      customerKind: request.customerKind,
      groupId: request.groupId,
      placeType: request.placeType,
      serviceCode: request.serviceCode,
    });
    const [names, labels] = await Promise.all([
      this.useCases.resolveNames.forRequests(page.items),
      this.useCases.describeRequests.execute(page.items, 'backoffice'),
    ]);
    return {
      requests: page.items.map((item) => presentRequest(item, names, labels)),
      nextCursor: page.nextCursor ?? '',
    };
  }

  async getQuoteRequest(
    request: cleaningV1.GetQuoteRequestRequest,
  ): Promise<cleaningV1.GetQuoteRequestResponse> {
    const found = await this.useCases.getQuoteRequest.execute(request.requestId);
    const siblings = await this.useCases.listGroupSiblings.execute(found);
    const labels = await this.useCases.describeRequests.execute([found, ...siblings], 'backoffice');
    return {
      request: await this.request(found),
      groupRequests: siblings.map((sibling) => presentSibling(sibling, labels)),
    };
  }

  async rejectQuoteRequest(
    request: cleaningV1.RejectQuoteRequestRequest,
  ): Promise<cleaningV1.RejectQuoteRequestResponse> {
    return { request: await this.request(await this.useCases.rejectQuoteRequest.execute(request)) };
  }

  async scheduleVisit(request: cleaningV1.ScheduleVisitRequest): Promise<cleaningV1.ScheduleVisitResponse> {
    return { request: await this.request(await this.useCases.scheduleVisit.execute(request)) };
  }

  async completeVisit(request: cleaningV1.CompleteVisitRequest): Promise<cleaningV1.CompleteVisitResponse> {
    const result = await this.useCases.completeVisit.execute({
      visitId: request.visitId,
      report: request.report,
      // Message absent : aucune mesure (ADR-037).
      measurements: request.measurements ? measurementFromProto(request.measurements) : undefined,
    });
    return { request: await this.request(result) };
  }

  // --- Mesures constatées et recalcul (ADR-037) -------------------------------------------------

  async estimateRequestPrice(
    request: cleaningV1.EstimateRequestPriceRequest,
  ): Promise<cleaningV1.EstimateRequestPriceResponse> {
    const result = await this.useCases.estimateRequestPrice.execute({
      requestId: request.requestId,
      ...measurementFromProto(request),
    });
    return {
      requestId: result.requestId,
      serviceCode: result.serviceCode,
      commune: result.commune,
      calculation: calculationToProto(result.calculation),
    };
  }

  async saveRequestMeasurements(
    request: cleaningV1.SaveRequestMeasurementsRequest,
  ): Promise<cleaningV1.SaveRequestMeasurementsResponse> {
    const result = await this.useCases.saveMeasurements.execute({
      requestId: request.requestId,
      ...measurementFromProto(request),
    });
    return { request: await this.request(result) };
  }

  async sendQuote(request: cleaningV1.SendQuoteRequest): Promise<cleaningV1.SendQuoteResponse> {
    const result = await this.useCases.sendQuote.execute({ ...request, lines: request.lines.map(toLine) });
    return { request: await this.request(result) };
  }

  // --- Demandes groupées, visites, position (ADR-035) ---------------------------------------------

  async scheduleGroupVisit(
    request: cleaningV1.ScheduleGroupVisitRequest,
  ): Promise<cleaningV1.ScheduleGroupVisitResponse> {
    const outcome = await this.useCases.scheduleGroupVisit.execute(request);
    return { outcome: presentOutcome(outcome), requests: await this.groupRequests(outcome.groupId) };
  }

  async completeGroupVisit(
    request: cleaningV1.CompleteGroupVisitRequest,
  ): Promise<cleaningV1.CompleteGroupVisitResponse> {
    const outcome = await this.useCases.completeGroupVisit.execute({
      groupId: request.groupId,
      report: request.report,
      idempotencyKey: request.idempotencyKey,
      measurements: request.measurements.map((item) => ({
        requestId: item.requestId,
        ...measurementFromProto(item),
      })),
    });
    // Un agent ne voit que les demandes dont il a la visite, sans leur position une fois close.
    return { outcome: presentOutcome(outcome), requests: await this.groupRequests(outcome.groupId) };
  }

  async rejectRequestGroup(
    request: cleaningV1.RejectRequestGroupRequest,
  ): Promise<cleaningV1.RejectRequestGroupResponse> {
    const outcome = await this.useCases.rejectRequestGroup.execute(request);
    return { outcome: presentOutcome(outcome), requests: await this.groupRequests(outcome.groupId) };
  }

  async sendGroupQuotes(
    request: cleaningV1.SendGroupQuotesRequest,
  ): Promise<cleaningV1.SendGroupQuotesResponse> {
    const outcome = await this.useCases.sendGroupQuotes.execute({
      ...request,
      quotes: request.quotes.map((item) => ({ ...item, lines: item.lines.map(toLine) })),
    });
    return { outcome: presentOutcome(outcome), requests: await this.groupRequests(outcome.groupId) };
  }

  async correctRequestLocation(
    request: cleaningV1.CorrectRequestLocationRequest,
  ): Promise<cleaningV1.CorrectRequestLocationResponse> {
    const result = await this.useCases.correctLocation.execute(request);
    return {
      request: await this.request(result.request),
      updatedRequestIds: result.requestIds,
      updatedMissionIds: result.missionIds,
    };
  }

  async listVisits(request: cleaningV1.ListVisitsRequest): Promise<cleaningV1.ListVisitsResponse> {
    const page = await this.useCases.listVisits.execute({
      page: parsePage(request.page),
      agentId: request.agentId,
      from: request.from,
      to: request.to,
      status: request.status,
      groupId: request.groupId,
    });
    const requests = page.items.flatMap((entry) => entry.requests);
    const [names, labels] = await Promise.all([
      this.useCases.resolveNames.forRequests(requests),
      this.useCases.describeRequests.execute(requests, 'backoffice'),
    ]);
    return {
      visits: page.items.map((entry) => presentVisit(entry, names, labels)),
      nextCursor: page.nextCursor ?? '',
    };
  }

  async scheduleGroupInterventions(
    request: cleaningV1.ScheduleGroupInterventionsRequest,
  ): Promise<cleaningV1.ScheduleGroupInterventionsResponse> {
    const { outcome, missions } = await this.useCases.scheduleGroupInterventions.execute(request);
    const views = await Promise.all(
      missions.map((mission) => this.useCases.getMissionDetail.execute(mission.id)),
    );
    const names = await this.useCases.resolveNames.forMissions(missions);
    return {
      groupId: outcome.groupId,
      scheduledMissionIds: outcome.missionIds,
      skipped: outcome.skippedMissions.map((entry) => ({ ...entry })),
      missions: views.map((view) => presentMission(view, names)),
    };
  }

  // --- Missions et passages ------------------------------------------------------------------

  async listMissions(request: cleaningV1.ListMissionsRequest): Promise<cleaningV1.ListMissionsResponse> {
    const page = await this.useCases.listMissions.execute({
      page: parsePage(request.page),
      status: request.status,
      groupId: request.groupId,
      serviceCode: request.serviceCode,
    });
    const names = await this.useCases.resolveNames.forMissions(page.items.map((view) => view.mission));
    return {
      missions: page.items.map((view) => presentMission(view, names)),
      nextCursor: page.nextCursor ?? '',
    };
  }

  async getMissionDetail(
    request: cleaningV1.GetMissionDetailRequest,
  ): Promise<cleaningV1.GetMissionDetailResponse> {
    return { mission: await this.mission(await this.useCases.getMissionDetail.execute(request.missionId)) };
  }

  async scheduleIntervention(
    request: cleaningV1.ScheduleInterventionRequest,
  ): Promise<cleaningV1.ScheduleInterventionResponse> {
    return { mission: await this.mission(await this.useCases.scheduleIntervention.execute(request)) };
  }

  async startIntervention(
    request: cleaningV1.StartInterventionRequest,
  ): Promise<cleaningV1.StartInterventionResponse> {
    return {
      mission: await this.mission(await this.useCases.startIntervention.execute(request.interventionId)),
    };
  }

  async updateChecklist(
    request: cleaningV1.UpdateChecklistRequest,
  ): Promise<cleaningV1.UpdateChecklistResponse> {
    return { mission: await this.mission(await this.useCases.updateChecklist.execute(request)) };
  }

  async reportIncident(
    request: cleaningV1.ReportIncidentRequest,
  ): Promise<cleaningV1.ReportIncidentResponse> {
    return { mission: await this.mission(await this.useCases.reportIncident.execute(request)) };
  }

  async resumeIntervention(
    request: cleaningV1.ResumeInterventionRequest,
  ): Promise<cleaningV1.ResumeInterventionResponse> {
    return {
      mission: await this.mission(await this.useCases.resumeIntervention.execute(request.interventionId)),
    };
  }

  async completeIntervention(
    request: cleaningV1.CompleteInterventionRequest,
  ): Promise<cleaningV1.CompleteInterventionResponse> {
    return {
      mission: await this.mission(await this.useCases.completeIntervention.execute(request.interventionId)),
    };
  }

  async recordPayment(request: cleaningV1.RecordPaymentRequest): Promise<cleaningV1.RecordPaymentResponse> {
    const result = await this.useCases.recordPayment.execute({
      missionId: request.missionId,
      amount: request.amount?.amount ?? 0,
      method: request.method,
      reference: request.reference,
      idempotencyKey: request.idempotencyKey,
    });
    return { mission: await this.mission(result) };
  }

  async cancelMissionAsSupervisor(
    request: cleaningV1.CancelMissionAsSupervisorRequest,
  ): Promise<cleaningV1.CancelMissionAsSupervisorResponse> {
    return { mission: await this.mission(await this.useCases.cancelMissionAsSupervisor.execute(request)) };
  }

  // --- Catalogue, grille, réglages -----------------------------------------------------------

  async getCatalog(): Promise<cleaningV1.GetCatalogResponse> {
    const { services, settings } = await this.useCases.getCatalog.execute();
    const names = await this.useCases.resolveNames.forAuthors([
      ...services.map((service) => service.pricing.updatedBy),
      settings.updatedBy,
    ]);
    return {
      services: services.map((service) => presentDefinition(service, names)),
      settings: presentSettings(settings, names),
      unplacedServiceCodes: await this.useCases.catalogConsistency.unplacedServices(services),
    };
  }

  async saveService(request: cleaningV1.SaveServiceRequest): Promise<cleaningV1.SaveServiceResponse> {
    const saved = await this.useCases.saveService.execute(
      request.service?.code ?? '',
      definitionFromProto(request.service),
    );
    // Prestation désactivée (ADR-034) : lieux qui la proposent encore (masquée sous eux).
    const affected = saved.active
      ? []
      : await this.useCases.catalogConsistency.placeTypesOffering(saved.code);
    return {
      service: await this.definition(saved),
      affectedPlaceTypes: affected.map((placeType) => ({ code: placeType.code, label: placeType.label })),
    };
  }

  async previewService(
    request: cleaningV1.PreviewServiceRequest,
  ): Promise<cleaningV1.PreviewServiceResponse> {
    const result = await this.useCases.previewService.execute({
      serviceCode: request.serviceCode,
      definition: request.definition ? definitionFromProto(request.definition) : undefined,
      answers: answersFromProto(request.answers),
      optionSelections: selectionsFromProto(request.optionSelections),
      commune: request.commune,
      frequency: request.frequency,
      requestedTeamSize: request.requestedTeamSize,
    });
    return {
      serviceCode: result.serviceCode,
      calculation: calculationToProto(result.calculation),
      covered: result.covered,
    };
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
      locationRetentionMonths: s?.locationRetentionMonths ?? 0,
      // ADR-053 : rappel absent gardé (0 le désactive) ; photos et durée à 0 gardées.
      quoteExpiryReminderDays: s?.quoteExpiryReminderDays,
      maxInterventionPhotos: s?.maxInterventionPhotos ?? 0,
      visitDurationMinutes: s?.visitDurationMinutes ?? 0,
    });
    return { settings: await this.settings(saved) };
  }

  // --- Zones desservies ----------------------------------------------------------------------

  async listZones(): Promise<cleaningV1.ListZonesResponse> {
    const zones = await this.useCases.listZones.execute();
    const names = await this.useCases.resolveNames.forAuthors(zones.map((view) => view.zone.updatedBy));
    return { zones: zones.map((view) => presentZone(view, names)) };
  }

  async saveZone(request: cleaningV1.SaveZoneRequest): Promise<cleaningV1.SaveZoneResponse> {
    const saved = await this.useCases.saveZone.execute({
      commune: request.commune,
      // Message absent : noms alternatifs en vigueur gardés (ADR-034).
      aliases: request.aliases ? request.aliases.names : undefined,
    });
    return { zone: await this.zone(saved) };
  }

  async deactivateZone(
    request: cleaningV1.DeactivateZoneRequest,
  ): Promise<cleaningV1.DeactivateZoneResponse> {
    const view = await this.useCases.deactivateZone.execute({ code: request.code, confirm: request.confirm });
    return { zone: await this.zone(view) };
  }

  // --- Types de lieu (ADR-034) -----------------------------------------------------------------

  async listPlaceTypes(): Promise<cleaningV1.ListPlaceTypesResponse> {
    const views = await this.useCases.listPlaceTypes.execute();
    const names = await this.useCases.resolveNames.forAuthors(views.map((view) => view.placeType.updatedBy));
    return { placeTypes: views.map((view) => presentPlaceType(view, names)) };
  }

  async savePlaceType(request: cleaningV1.SavePlaceTypeRequest): Promise<cleaningV1.SavePlaceTypeResponse> {
    const input = request.placeType;
    const view = await this.useCases.savePlaceType.execute({
      code: input?.code ?? '',
      label: input?.label ?? '',
      description: input?.description ?? '',
      icon: input?.icon ?? '',
      displayOrder: input?.displayOrder ?? 0,
      active: input?.active ?? false,
      serviceCodes: input?.serviceCodes ?? [],
    });
    const names = await this.useCases.resolveNames.forAuthors([view.placeType.updatedBy]);
    return { placeType: presentPlaceType(view, names) };
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
    const { agent, overlapping } = await this.useCases.declareUnavailability.execute(request);
    return { agent: presentAgent(agent), overlappingAssignments: overlapping.map(presentAssignment) };
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

  // --- Compléments du Nettoyage (ADR-053) ---------------------------------------------------------

  async addInterventionPhoto(
    request: cleaningV1.AddInterventionPhotoRequest,
  ): Promise<cleaningV1.AddInterventionPhotoResponse> {
    return { mission: await this.mission(await this.useCases.addInterventionPhoto.execute(request)) };
  }

  async removeInterventionPhoto(
    request: cleaningV1.RemoveInterventionPhotoRequest,
  ): Promise<cleaningV1.RemoveInterventionPhotoResponse> {
    return { mission: await this.mission(await this.useCases.removeInterventionPhoto.execute(request)) };
  }

  async listInterventionPhotos(
    request: cleaningV1.ListInterventionPhotosRequest,
  ): Promise<cleaningV1.ListInterventionPhotosResponse> {
    const photos = await this.useCases.listInterventionPhotos.execute(request.interventionId);
    return { photos: photos.map(presentPhoto) };
  }

  async rescheduleIntervention(
    request: cleaningV1.RescheduleInterventionRequest,
  ): Promise<cleaningV1.RescheduleInterventionResponse> {
    return { mission: await this.mission(await this.useCases.rescheduleIntervention.execute(request)) };
  }

  async unscheduleIntervention(
    request: cleaningV1.UnscheduleInterventionRequest,
  ): Promise<cleaningV1.UnscheduleInterventionResponse> {
    return { mission: await this.mission(await this.useCases.unscheduleIntervention.execute(request)) };
  }

  async deactivateAgent(
    request: cleaningV1.DeactivateAgentRequest,
  ): Promise<cleaningV1.DeactivateAgentResponse> {
    return { agent: presentAgent(await this.useCases.deactivateAgent.execute(request.agentId)) };
  }

  async reactivateAgent(
    request: cleaningV1.ReactivateAgentRequest,
  ): Promise<cleaningV1.ReactivateAgentResponse> {
    return { agent: presentAgent(await this.useCases.reactivateAgent.execute(request.agentId)) };
  }

  async removeUnavailability(
    request: cleaningV1.RemoveUnavailabilityRequest,
  ): Promise<cleaningV1.RemoveUnavailabilityResponse> {
    return { agent: presentAgent(await this.useCases.removeUnavailability.execute(request)) };
  }

  async deactivateTeam(
    request: cleaningV1.DeactivateTeamRequest,
  ): Promise<cleaningV1.DeactivateTeamResponse> {
    const team = await this.useCases.deactivateTeam.execute(request.teamId);
    return { team: presentTeam(team, await this.useCases.listAgents.execute()) };
  }

  async reactivateTeam(
    request: cleaningV1.ReactivateTeamRequest,
  ): Promise<cleaningV1.ReactivateTeamResponse> {
    const team = await this.useCases.reactivateTeam.execute(request.teamId);
    return { team: presentTeam(team, await this.useCases.listAgents.execute()) };
  }

  // --- Noms affichés (ADR-029) -----------------------------------------------------------------

  private async request(request: QuoteRequest): Promise<cleaningV1.QuoteRequest> {
    const [names, labels] = await Promise.all([
      this.useCases.resolveNames.forRequests([request]),
      this.useCases.describeRequests.execute([request], 'backoffice'),
    ]);
    return presentRequest(request, names, labels);
  }

  private async mission(view: MissionView): Promise<cleaningV1.Mission> {
    return presentMission(view, await this.useCases.resolveNames.forMissions([view.mission]));
  }

  private async definition(service: ServiceDefinition): Promise<cleaningV1.ServiceDefinition> {
    return presentDefinition(
      service,
      await this.useCases.resolveNames.forAuthors([service.pricing.updatedBy]),
    );
  }

  private async settings(settings: StoredSettings): Promise<cleaningV1.Settings> {
    return presentSettings(settings, await this.useCases.resolveNames.forAuthors([settings.updatedBy]));
  }

  private async zone(view: ZoneView): Promise<cleaningV1.Zone> {
    return presentZone(view, await this.useCases.resolveNames.forAuthors([view.zone.updatedBy]));
  }

  /** Demandes d'un groupe après une opération (ADR-035), avec noms et libellés. */
  private async groupRequests(groupId: string): Promise<cleaningV1.QuoteRequest[]> {
    const view = await this.useCases.getRequestGroup.execute(groupId);
    const [names, labels] = await Promise.all([
      this.useCases.resolveNames.forRequests(view.requests),
      this.useCases.describeRequests.execute(view.requests, 'backoffice'),
    ]);
    return view.requests.map((item) => presentRequest(item, names, labels));
  }
}
