import { cleaningV1, commonV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { parsePage } from '../../application/shared/validation';
import { CLEANING_USE_CASES, type CleaningUseCases } from '../../application/use-cases';
import { type QuoteRequestGroupView } from '../../application/ports';
import { type QuoteRequest } from '../../domain/quote-request';
import {
  money,
  presentGroup,
  presentOutcome,
  presentLine,
  presentMission,
  presentOffer,
  presentPublicPlaceType,
  presentRequest,
  presentSchedulePreview,
  presentServedZone,
} from './presenters';
import { presentPhoto } from './complement.presenters';
import {
  answersFromProto,
  calculationToProto,
  pricingInputFromProto,
  selectionsFromProto,
} from './form.presenters';

/** Réponses d'une prestation d'une estimation ou d'un groupe (nouveau format seulement, ADR-034). */
const placeItemFromProto = (item: {
  serviceCode: string;
  answers?: cleaningV1.AnswerSet | undefined;
  optionSelections: cleaningV1.OptionSelection[];
  frequency: string;
}) => ({
  serviceCode: item.serviceCode,
  ...(item.answers ? { answers: answersFromProto(item.answers) } : {}),
  optionSelections: selectionsFromProto(item.optionSelections),
  frequency: item.frequency,
});

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
    const { serviceCode, calculation, notice, covered, communeApplied, schedule } =
      await this.useCases.simulate.execute({
        serviceCode: request.serviceCode,
        commune: request.commune,
        schedule: request.schedule,
        ...pricingInputFromProto(request),
      });
    const commune = calculation.coefficients.find((coefficient) => coefficient.source === 'commune');
    return {
      serviceCode,
      priced: calculation.priced,
      estimate: calculation.estimate
        ? { low: money(calculation.estimate.low), high: money(calculation.estimate.high) }
        : undefined,
      computedPrice: calculation.computedPrice === null ? undefined : money(calculation.computedPrice),
      breakdown: calculation.priced ? calculation.lines.map(presentLine) : [],
      minimumApplied: calculation.minimumApplied,
      // Sans commune (ADR-034) : coefficient neutre.
      communeCoefficientBp: calculation.priced ? (commune?.coefficientBp ?? 10_000) : 0,
      recommendedTeamSize: calculation.recommendedTeamSize,
      notice,
      covered,
      reason: calculation.reason ?? '',
      calculation: calculationToProto(calculation),
      communeApplied,
      // Plan de passages (ADR-052) : dates et montant sur leur nombre exact.
      schedule: schedule ? presentSchedulePreview(schedule.preview) : undefined,
      scheduleTotal: schedule?.total == null ? undefined : money(schedule.total),
      scheduleEstimate: schedule?.estimate
        ? { low: money(schedule.estimate.low), high: money(schedule.estimate.high) }
        : undefined,
    };
  }

  async previewSchedule(
    request: cleaningV1.PreviewScheduleRequest,
  ): Promise<cleaningV1.PreviewScheduleResponse> {
    return { preview: presentSchedulePreview(await this.useCases.previewSchedule.execute(request.schedule)) };
  }

  async getPlaceCatalog(): Promise<cleaningV1.GetPlaceCatalogResponse> {
    const { placeTypes, services } = await this.useCases.getPlaceCatalog.execute();
    return { placeTypes: placeTypes.map(presentPublicPlaceType), services: services.map(presentOffer) };
  }

  async estimate(request: cleaningV1.EstimateRequest): Promise<cleaningV1.EstimateResponse> {
    const result = await this.useCases.estimate.execute({
      placeType: request.placeType,
      commune: request.commune,
      items: request.items.map(placeItemFromProto),
    });
    return {
      placeType: result.placeType,
      commune: result.commune ?? '',
      communeApplied: result.communeApplied,
      covered: result.covered,
      status: result.status,
      total: result.total === null ? undefined : money(result.total),
      notice: result.notice,
      items: result.items.map((item) => ({
        serviceCode: item.service.code,
        serviceName: item.service.name,
        priced: item.calculation.priced,
        reason: item.calculation.reason ?? '',
        notice: item.notice,
        calculation: calculationToProto(item.calculation),
      })),
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
    const { answers: _answers, optionSelections: _selections, ...rest } = request;
    const input = { ...rest, ...pricingInputFromProto(request) };
    return { request: await this.request(await this.useCases.requestQuote.execute(input)) };
  }

  async listMyRequests(
    request: cleaningV1.ListMyRequestsRequest,
  ): Promise<cleaningV1.ListMyRequestsResponse> {
    const page = await this.useCases.listMyRequests.execute(parsePage(request.page));
    const labels = await this.useCases.describeRequests.execute(page.items);
    return {
      requests: page.items.map((item) => presentRequest(item, undefined, labels)),
      nextCursor: page.nextCursor ?? '',
    };
  }

  async getRequest(request: cleaningV1.GetRequestRequest): Promise<cleaningV1.GetRequestResponse> {
    return { request: await this.request(await this.useCases.getMyRequest.execute(request.requestId)) };
  }

  async acceptQuote(request: cleaningV1.AcceptQuoteRequest): Promise<cleaningV1.AcceptQuoteResponse> {
    const result = await this.useCases.acceptQuote.execute(request);
    return { request: await this.request(result.request), mission: presentMission(result.mission) };
  }

  async declineQuote(request: cleaningV1.DeclineQuoteRequest): Promise<cleaningV1.DeclineQuoteResponse> {
    return { request: await this.request(await this.useCases.declineQuote.execute(request)) };
  }

  async cancelRequest(request: cleaningV1.CancelRequestRequest): Promise<cleaningV1.CancelRequestResponse> {
    return { request: await this.request(await this.useCases.cancelRequest.execute(request)) };
  }

  async resolveLocation(
    request: cleaningV1.ResolveLocationRequest,
  ): Promise<cleaningV1.ResolveLocationResponse> {
    const result = await this.useCases.resolveLocation.execute(request);
    return {
      latitude: result.latitude,
      longitude: result.longitude,
      commune: result.commune ?? '',
      zoneCode: result.zoneCode ?? '',
      served: result.served,
      displayAddress: result.displayAddress ?? '',
      provider: result.provider ?? '',
    };
  }

  async requestQuoteGroup(
    request: cleaningV1.RequestQuoteGroupRequest,
  ): Promise<cleaningV1.RequestQuoteGroupResponse> {
    const view = await this.useCases.requestQuoteGroup.execute({
      idempotencyKey: request.idempotencyKey,
      placeType: request.placeType,
      location: request.location,
      landmark: request.landmark,
      commune: request.commune,
      items: request.items.map((item) => ({
        ...placeItemFromProto(item),
        requestedTeamSize: item.requestedTeamSize,
      })),
      preferredSlots: request.preferredSlots,
      comment: request.comment,
      recurrence: request.recurrence,
      schedule: request.schedule,
    });
    return { group: await this.group(view) };
  }

  async getRequestGroup(
    request: cleaningV1.GetRequestGroupRequest,
  ): Promise<cleaningV1.GetRequestGroupResponse> {
    return { group: await this.group(await this.useCases.getMyRequestGroup.execute(request.groupId)) };
  }

  async cancelRequestGroup(
    request: cleaningV1.CancelRequestGroupRequest,
  ): Promise<cleaningV1.CancelRequestGroupResponse> {
    const outcome = await this.useCases.cancelRequestGroup.execute(request);
    return {
      outcome: presentOutcome(outcome),
      group: await this.group(await this.useCases.getMyRequestGroup.execute(outcome.groupId)),
    };
  }

  async acceptGroupQuotes(
    request: cleaningV1.AcceptGroupQuotesRequest,
  ): Promise<cleaningV1.AcceptGroupQuotesResponse> {
    const outcome = await this.useCases.acceptGroupQuotes.execute(request);
    return {
      outcome: presentOutcome(outcome),
      group: await this.group(await this.useCases.getMyRequestGroup.execute(outcome.groupId)),
    };
  }

  /** Demande avec ses libellés (prestation, lieu, taille du groupe ; ADR-034). */
  private async request(request: QuoteRequest): Promise<cleaningV1.QuoteRequest> {
    return presentRequest(request, undefined, await this.useCases.describeRequests.execute([request]));
  }

  private async group(view: QuoteRequestGroupView): Promise<cleaningV1.QuoteRequestGroup> {
    const [labels, totals] = await Promise.all([
      this.useCases.describeRequests.execute(view.requests),
      this.useCases.groupTotals.execute(view),
    ]);
    return presentGroup(view, labels, totals);
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

  async payMissionFromWallet(
    request: cleaningV1.PayMissionFromWalletRequest,
  ): Promise<cleaningV1.PayMissionFromWalletResponse> {
    const view = await this.useCases.payMissionFromWallet.execute({
      missionId: request.missionId,
      part: request.part,
      idempotencyKey: request.idempotencyKey,
    });
    return { mission: presentMission(view) };
  }

  /** Photos d'un passage de la mission du client (ADR-053). */
  async listMyInterventionPhotos(
    request: cleaningV1.ListMyInterventionPhotosRequest,
  ): Promise<cleaningV1.ListMyInterventionPhotosResponse> {
    const photos = await this.useCases.listMyInterventionPhotos.execute(request.interventionId);
    return { photos: photos.map(presentPhoto) };
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

/**
 * MissionPaymentDueService : montant dû d'une mission, réservé au service payment (ADR-031). Le
 * contrôle de l'appelant est fait par le cas d'usage.
 */
@Controller()
@cleaningV1.MissionPaymentDueServiceControllerMethods()
export class MissionPaymentDueGrpcController implements cleaningV1.MissionPaymentDueServiceController {
  constructor(@Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases) {}

  async getMissionAmountDue(
    request: cleaningV1.GetMissionAmountDueRequest,
  ): Promise<cleaningV1.GetMissionAmountDueResponse> {
    const due = await this.useCases.getMissionAmountDue.execute(request.missionId);
    return {
      missionId: due.mission.id,
      customerId: due.mission.customerId,
      organizationId: due.mission.organizationId ?? '',
      status: due.mission.status,
      plan: { ...due.mission.payment.plan },
      total: money(due.mission.payment.total),
      paid: money(due.paid),
      depositDue: money(due.depositDue),
      remainingDue: money(due.remainingDue),
      onlinePaymentIds: due.onlinePaymentIds,
    };
  }
}

/**
 * WalletDebitCheckService : débit du portefeuille enregistré sur une mission ?, réservé au service
 * wallet (ADR-048). Le contrôle de l'appelant est fait par le cas d'usage.
 */
@Controller()
@cleaningV1.WalletDebitCheckServiceControllerMethods()
export class WalletDebitCheckGrpcController implements cleaningV1.WalletDebitCheckServiceController {
  constructor(@Inject(CLEANING_USE_CASES) private readonly useCases: CleaningUseCases) {}

  async getWalletDebitStatus(
    request: cleaningV1.GetWalletDebitStatusRequest,
  ): Promise<cleaningV1.GetWalletDebitStatusResponse> {
    return {
      recorded: await this.useCases.getWalletDebitStatus.execute({
        missionId: request.missionId,
        transactionId: request.transactionId,
      }),
    };
  }
}
