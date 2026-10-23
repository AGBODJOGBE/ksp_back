import {
  GetCatalogUseCase,
  SaveServiceUseCase,
  UpdateSettingsUseCase,
} from './catalog/admin-catalog.use-cases';
import { ListServicesUseCase, SimulateUseCase } from './catalog/catalog.use-cases';
import { type CleaningDeps } from './deps';
import {
  CancelMissionAsSupervisorUseCase,
  CompleteInterventionUseCase,
  GetMissionDetailUseCase,
  ListMissionsUseCase,
  RecordPaymentUseCase,
  ReportIncidentUseCase,
  ResumeInterventionUseCase,
  ScheduleInterventionUseCase,
  StartInterventionUseCase,
  UpdateChecklistUseCase,
} from './missions/admin-missions.use-cases';
import {
  CancelMyMissionUseCase,
  GetMyMissionUseCase,
  ListMyMissionsUseCase,
} from './missions/customer-missions.use-cases';
import { HasPendingObligationsUseCase } from './obligations/has-pending-obligations.use-case';
import {
  CompleteVisitUseCase,
  GetQuoteRequestUseCase,
  ListQuoteRequestsUseCase,
  RejectQuoteRequestUseCase,
  ScheduleVisitUseCase,
  SendQuoteUseCase,
} from './requests/admin-requests.use-cases';
import {
  AcceptQuoteUseCase,
  CancelRequestUseCase,
  DeclineQuoteUseCase,
  GetMyRequestUseCase,
  ListMyRequestsUseCase,
  RequestQuoteUseCase,
} from './requests/customer-requests.use-cases';
import {
  CreateTeamUseCase,
  DeclareUnavailabilityUseCase,
  ListAgentsUseCase,
  ListTeamsUseCase,
  RegisterAgentUseCase,
  UpdateTeamUseCase,
} from './teams/admin-teams.use-cases';

/** Les cas d'usage UC-CL-01 à 12 (une classe chacun), reliés aux mêmes dépendances. */
export function createUseCases(deps: CleaningDeps) {
  return {
    listServices: new ListServicesUseCase(deps),
    simulate: new SimulateUseCase(deps),
    requestQuote: new RequestQuoteUseCase(deps),
    listMyRequests: new ListMyRequestsUseCase(deps),
    getMyRequest: new GetMyRequestUseCase(deps),
    acceptQuote: new AcceptQuoteUseCase(deps),
    declineQuote: new DeclineQuoteUseCase(deps),
    cancelRequest: new CancelRequestUseCase(deps),
    listMyMissions: new ListMyMissionsUseCase(deps),
    getMyMission: new GetMyMissionUseCase(deps),
    cancelMyMission: new CancelMyMissionUseCase(deps),
    listQuoteRequests: new ListQuoteRequestsUseCase(deps),
    getQuoteRequest: new GetQuoteRequestUseCase(deps),
    rejectQuoteRequest: new RejectQuoteRequestUseCase(deps),
    scheduleVisit: new ScheduleVisitUseCase(deps),
    completeVisit: new CompleteVisitUseCase(deps),
    sendQuote: new SendQuoteUseCase(deps),
    listMissions: new ListMissionsUseCase(deps),
    getMissionDetail: new GetMissionDetailUseCase(deps),
    scheduleIntervention: new ScheduleInterventionUseCase(deps),
    startIntervention: new StartInterventionUseCase(deps),
    updateChecklist: new UpdateChecklistUseCase(deps),
    reportIncident: new ReportIncidentUseCase(deps),
    resumeIntervention: new ResumeInterventionUseCase(deps),
    completeIntervention: new CompleteInterventionUseCase(deps),
    recordPayment: new RecordPaymentUseCase(deps),
    cancelMissionAsSupervisor: new CancelMissionAsSupervisorUseCase(deps),
    getCatalog: new GetCatalogUseCase(deps),
    saveService: new SaveServiceUseCase(deps),
    updateSettings: new UpdateSettingsUseCase(deps),
    listAgents: new ListAgentsUseCase(deps),
    registerAgent: new RegisterAgentUseCase(deps),
    declareUnavailability: new DeclareUnavailabilityUseCase(deps),
    listTeams: new ListTeamsUseCase(deps),
    createTeam: new CreateTeamUseCase(deps),
    updateTeam: new UpdateTeamUseCase(deps),
    hasPendingObligations: new HasPendingObligationsUseCase(deps),
  };
}

export type CleaningUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection de l'ensemble des cas d'usage. */
export const CLEANING_USE_CASES = Symbol('CLEANING_USE_CASES');
