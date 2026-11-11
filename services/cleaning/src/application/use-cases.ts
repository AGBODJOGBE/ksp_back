import { ScheduleInterventionBatchUseCase } from './missions/intervention-batch.use-case';
import {
  GetWalletDebitStatusUseCase,
  PayMissionFromWalletUseCase,
} from './payments/wallet-payments.use-cases';
import { ResolveBackofficeNamesUseCase } from './backoffice/backoffice-names.use-case';
import {
  GetCatalogUseCase,
  PreviewServiceUseCase,
  SaveServiceUseCase,
  UpdateSettingsUseCase,
} from './catalog/admin-catalog.use-cases';
import {
  ListServedZonesUseCase,
  ListServicesUseCase,
  PreviewScheduleUseCase,
  SimulateUseCase,
} from './catalog/catalog.use-cases';
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
import { DeactivateZoneUseCase, ListZonesUseCase, SaveZoneUseCase } from './catalog/zones.use-cases';
import { CancelRequestGroupUseCase, RejectRequestGroupUseCase } from './groups/group-decisions.use-cases';
import { ScheduleGroupInterventionsUseCase } from './groups/group-interventions.use-case';
import { AcceptGroupQuotesUseCase, SendGroupQuotesUseCase } from './groups/group-quotes.use-cases';
import { GetRequestGroupUseCase, GroupTotalsUseCase } from './groups/group-totals.use-case';
import {
  CompleteGroupVisitUseCase,
  ListVisitsUseCase,
  ScheduleGroupVisitUseCase,
} from './groups/group-visits.use-cases';
import { CorrectLocationUseCase } from './places/location-correction.use-case';
import { EraseCustomerLocationsUseCase, PurgeLocationsUseCase } from './privacy/location-privacy.use-cases';
import { HasPendingObligationsUseCase } from './obligations/has-pending-obligations.use-case';
import { ResolveLocationUseCase } from './places/location.use-cases';
import { DescribeRequestsUseCase } from './places/request-labels.use-case';
import {
  CatalogConsistencyUseCase,
  EstimateUseCase,
  GetPlaceCatalogUseCase,
  ListPlaceTypesUseCase,
  SavePlaceTypeUseCase,
} from './places/place-catalog.use-cases';
import {
  GetMyRequestGroupUseCase,
  ListGroupSiblingsUseCase,
  RequestQuoteGroupUseCase,
} from './places/request-groups.use-cases';
import { GetMissionAmountDueUseCase, RecordOnlinePaymentUseCase } from './payments/online-payments.use-cases';
import {
  HandleOrganizationEventUseCase,
  ReconcileOrganizationUseCase,
} from './standing/organization.use-cases';
import {
  EvaluateStandingUseCase,
  HandleInvoiceEventUseCase,
  MissionSuspension,
  WatchIndividualPaymentsUseCase,
} from './standing/standing.use-cases';
import {
  CompleteVisitUseCase,
  GetQuoteRequestUseCase,
  ListQuoteRequestsUseCase,
  RejectQuoteRequestUseCase,
  ScheduleVisitUseCase,
  SendQuoteUseCase,
} from './requests/admin-requests.use-cases';
import { EstimateRequestPriceUseCase, SaveMeasurementsUseCase } from './requests/measurements.use-cases';
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
  const suspension = new MissionSuspension(deps);
  const evaluateStanding = new EvaluateStandingUseCase(deps, suspension);
  const reconcileOrganization = new ReconcileOrganizationUseCase(deps, suspension, evaluateStanding);
  return {
    listServices: new ListServicesUseCase(deps),
    simulate: new SimulateUseCase(deps),
    previewSchedule: new PreviewScheduleUseCase(deps),
    listServedZones: new ListServedZonesUseCase(deps),
    getPlaceCatalog: new GetPlaceCatalogUseCase(deps),
    estimate: new EstimateUseCase(deps),
    resolveLocation: new ResolveLocationUseCase(deps),
    requestQuoteGroup: new RequestQuoteGroupUseCase(deps),
    getMyRequestGroup: new GetMyRequestGroupUseCase(deps),
    listGroupSiblings: new ListGroupSiblingsUseCase(deps),
    listPlaceTypes: new ListPlaceTypesUseCase(deps),
    savePlaceType: new SavePlaceTypeUseCase(deps),
    catalogConsistency: new CatalogConsistencyUseCase(deps),
    describeRequests: new DescribeRequestsUseCase(deps),
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
    estimateRequestPrice: new EstimateRequestPriceUseCase(deps),
    saveMeasurements: new SaveMeasurementsUseCase(deps),
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
    payMissionFromWallet: new PayMissionFromWalletUseCase(deps),
    getWalletDebitStatus: new GetWalletDebitStatusUseCase(deps),
    cancelMissionAsSupervisor: new CancelMissionAsSupervisorUseCase(deps),
    getCatalog: new GetCatalogUseCase(deps),
    saveService: new SaveServiceUseCase(deps),
    previewService: new PreviewServiceUseCase(deps),
    updateSettings: new UpdateSettingsUseCase(deps),
    listAgents: new ListAgentsUseCase(deps),
    registerAgent: new RegisterAgentUseCase(deps),
    declareUnavailability: new DeclareUnavailabilityUseCase(deps),
    listTeams: new ListTeamsUseCase(deps),
    createTeam: new CreateTeamUseCase(deps),
    updateTeam: new UpdateTeamUseCase(deps),
    hasPendingObligations: new HasPendingObligationsUseCase(deps),
    listZones: new ListZonesUseCase(deps),
    saveZone: new SaveZoneUseCase(deps),
    deactivateZone: new DeactivateZoneUseCase(deps),
    resolveNames: new ResolveBackofficeNamesUseCase(deps),
    evaluateStanding,
    handleInvoiceEvent: new HandleInvoiceEventUseCase(deps, evaluateStanding),
    watchIndividualPayments: new WatchIndividualPaymentsUseCase(deps, evaluateStanding),
    reconcileOrganization,
    handleOrganizationEvent: new HandleOrganizationEventUseCase(deps, reconcileOrganization),
    getMissionAmountDue: new GetMissionAmountDueUseCase(deps),
    recordOnlinePayment: new RecordOnlinePaymentUseCase(deps, evaluateStanding),
    // Demandes groupées, visites, position (ADR-035).
    rejectRequestGroup: new RejectRequestGroupUseCase(deps),
    cancelRequestGroup: new CancelRequestGroupUseCase(deps),
    scheduleGroupVisit: new ScheduleGroupVisitUseCase(deps),
    completeGroupVisit: new CompleteGroupVisitUseCase(deps),
    listVisits: new ListVisitsUseCase(deps),
    sendGroupQuotes: new SendGroupQuotesUseCase(deps),
    acceptGroupQuotes: new AcceptGroupQuotesUseCase(deps),
    scheduleGroupInterventions: new ScheduleGroupInterventionsUseCase(deps),
    scheduleInterventionBatch: new ScheduleInterventionBatchUseCase(deps),
    groupTotals: new GroupTotalsUseCase(deps),
    getRequestGroup: new GetRequestGroupUseCase(deps),
    correctLocation: new CorrectLocationUseCase(deps),
    purgeLocations: new PurgeLocationsUseCase(deps),
    eraseCustomerLocations: new EraseCustomerLocationsUseCase(deps),
  };
}

export type CleaningUseCases = ReturnType<typeof createUseCases>;

/** Jeton d'injection de l'ensemble des cas d'usage. */
export const CLEANING_USE_CASES = Symbol('CLEANING_USE_CASES');
