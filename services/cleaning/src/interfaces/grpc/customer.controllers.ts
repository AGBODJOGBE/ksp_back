import { cleaningV1, commonV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { parsePage } from '../../application/shared/validation';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';
import {
  money,
  presentLine,
  presentMission,
  presentOffer,
  presentRequest,
  presentServedZone,
} from './presenters';

/**
 * Adaptateurs gRPC du catalogue public et de l'espace client : traduction des messages et appel
 * du cas d'usage, sans règle métier. L'utilisateur vient du contexte posé par la gateway.
 * Aucun journal des requêtes : elles portent l'adresse d'intervention.
 */
@Controller()
@cleaningV1.CatalogServiceControllerMethods()
export class CatalogGrpcController implements cleaningV1.CatalogServiceController {
  constructor(@Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases) {}

  async listServices(): Promise<cleaningV1.ListServicesResponse> {
    return { services: (await this.useCases.listServices.execute()).map(presentOffer) };
  }

  async simulate(request: cleaningV1.SimulateRequest): Promise<cleaningV1.SimulateResponse> {
    const { serviceCode, simulation, notice, covered } = await this.useCases.simulate.execute(request);
    const base = {
      serviceCode,
      notice,
      recommendedTeamSize: simulation.recommendedTeamSize,
      breakdown: [] as cleaningV1.PriceLine[],
      minimumApplied: false,
      communeCoefficientBp: 0,
      covered,
    };
    if (!simulation.priced) return { ...base, priced: false };
    return {
      ...base,
      priced: true,
      estimate: { low: money(simulation.low), high: money(simulation.high) },
      computedPrice: money(simulation.computedPrice),
      breakdown: simulation.breakdown.map(presentLine),
      minimumApplied: simulation.minimumApplied,
      communeCoefficientBp: simulation.coefficientBp,
    };
  }

  async listServedZones(): Promise<cleaningV1.ListServedZonesResponse> {
    return { zones: (await this.useCases.listServedZones.execute()).map(presentServedZone) };
  }
}

@Controller()
@cleaningV1.QuoteServiceControllerMethods()
export class QuoteGrpcController implements cleaningV1.QuoteServiceController {
  constructor(@Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases) {}

  async requestQuote(request: cleaningV1.RequestQuoteRequest): Promise<cleaningV1.RequestQuoteResponse> {
    return { request: presentRequest(await this.useCases.requestQuote.execute(request)) };
  }

  async listMyRequests(
    request: cleaningV1.ListMyRequestsRequest,
  ): Promise<cleaningV1.ListMyRequestsResponse> {
    const page = await this.useCases.listMyRequests.execute(parsePage(request.page));
    return { requests: page.items.map((item) => presentRequest(item)), nextCursor: page.nextCursor ?? '' };
  }

  async getRequest(request: cleaningV1.GetRequestRequest): Promise<cleaningV1.GetRequestResponse> {
    return { request: presentRequest(await this.useCases.getMyRequest.execute(request.requestId)) };
  }

  async acceptQuote(request: cleaningV1.AcceptQuoteRequest): Promise<cleaningV1.AcceptQuoteResponse> {
    const result = await this.useCases.acceptQuote.execute(request);
    return { request: presentRequest(result.request), mission: presentMission(result.mission) };
  }

  async declineQuote(request: cleaningV1.DeclineQuoteRequest): Promise<cleaningV1.DeclineQuoteResponse> {
    return { request: presentRequest(await this.useCases.declineQuote.execute(request)) };
  }

  async cancelRequest(request: cleaningV1.CancelRequestRequest): Promise<cleaningV1.CancelRequestResponse> {
    return { request: presentRequest(await this.useCases.cancelRequest.execute(request)) };
  }
}

@Controller()
@cleaningV1.MissionServiceControllerMethods()
export class MissionGrpcController implements cleaningV1.MissionServiceController {
  constructor(@Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases) {}

  async listMyMissions(
    request: cleaningV1.ListMyMissionsRequest,
  ): Promise<cleaningV1.ListMyMissionsResponse> {
    const page = await this.useCases.listMyMissions.execute(parsePage(request.page));
    return { missions: page.items.map((item) => presentMission(item)), nextCursor: page.nextCursor ?? '' };
  }

  async getMission(request: cleaningV1.GetMissionRequest): Promise<cleaningV1.GetMissionResponse> {
    return { mission: presentMission(await this.useCases.getMyMission.execute(request.missionId)) };
  }

  async cancelMission(request: cleaningV1.CancelMissionRequest): Promise<cleaningV1.CancelMissionResponse> {
    return { mission: presentMission(await this.useCases.cancelMyMission.execute(request)) };
  }
}

/** ksp.common.v1.ObligationService, interrogé par identity avant la suppression d'un compte. */
@Controller()
@commonV1.ObligationServiceControllerMethods()
export class ObligationGrpcController implements commonV1.ObligationServiceController {
  constructor(@Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases) {}

  async hasPendingObligations(
    request: commonV1.HasPendingObligationsRequest,
  ): Promise<commonV1.HasPendingObligationsResponse> {
    const obligations = await this.useCases.hasPendingObligations.execute({ userId: request.userId });
    return { hasPending: obligations.length > 0, obligations };
  }
}
