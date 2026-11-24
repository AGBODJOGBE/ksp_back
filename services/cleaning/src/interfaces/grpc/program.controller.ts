import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { CustomerProgramUseCases } from '../../application/execution/customer-programs.use-cases';
import { CLEANING_DEPS, type CleaningDeps, type ExecutionDeps } from '../../application/deps';
import { CUSTOMER, presentPaymentOutcome, presentProgram, presentSession } from './execution-presenters';
// Lot G
import { ClaimUseCases } from '../../application/claims/claims.use-cases';
import { toClaim, toClaimPage } from './claim.presenters';
// Piste P
import { ProgramRenewalUseCases } from '../../application/requests/program-renewal.use-cases';
import { type Audience as CaseAudience, CasePresenter } from './case.presenters';
import { scheduleFromProto } from './simulation.presenters';

/** Demande rendue au client par le renouvellement et la nouvelle commande. */
const CUSTOMER_CASE: CaseAudience = { kind: 'customer', amounts: true };

/**
 * Adaptateur gRPC de ProgramService — programmes, séances, paiements, notes et réclamations du
 * client (UC-NT-11 à 18). Lot E livré : programmes et séances, report, annulation, arrêt, paiement
 * et note d'une séance. Lot G livré : réclamations (UC-NT-17). Piste P livrée : renouvellement et
 * nouvelle commande (UC-NT-18).
 */
@Controller()
@cleaningV1.ProgramServiceControllerMethods()
export class ProgramGrpcController implements cleaningV1.ProgramServiceController {
  private readonly programs: CustomerProgramUseCases;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.programs = new CustomerProgramUseCases(deps as ExecutionDeps);
  }

  async listMyPrograms(
    request: cleaningV1.ListMyProgramsRequest,
  ): Promise<cleaningV1.ListMyProgramsResponse> {
    const page = await this.programs.listPrograms(request);
    return {
      items: page.items.map((program) => presentProgram(program, CUSTOMER)),
      nextCursor: page.nextCursor ?? '',
      total: page.total,
    };
  }

  async getMyProgram(request: cleaningV1.GetMyProgramRequest): Promise<cleaningV1.GetMyProgramResponse> {
    return { program: presentProgram(await this.programs.getProgram(request.programId), CUSTOMER) };
  }

  async listMyProgramSessions(
    request: cleaningV1.ListMyProgramSessionsRequest,
  ): Promise<cleaningV1.ListMyProgramSessionsResponse> {
    const page = await this.programs.listSessions(request);
    return {
      items: page.items.map((session) => presentSession(session, CUSTOMER)),
      nextCursor: page.nextCursor ?? '',
      total: page.total,
    };
  }

  async getMySession(request: cleaningV1.GetMySessionRequest): Promise<cleaningV1.GetMySessionResponse> {
    return { session: presentSession(await this.programs.getSession(request.sessionId), CUSTOMER) };
  }

  async rescheduleSession(
    request: cleaningV1.RescheduleSessionRequest,
  ): Promise<cleaningV1.RescheduleSessionResponse> {
    return { session: presentSession(await this.programs.reschedule(request), CUSTOMER) };
  }

  async cancelSession(request: cleaningV1.CancelSessionRequest): Promise<cleaningV1.CancelSessionResponse> {
    return { session: presentSession(await this.programs.cancelSession(request), CUSTOMER) };
  }

  async stopProgram(request: cleaningV1.StopProgramRequest): Promise<cleaningV1.StopProgramResponse> {
    return { program: presentProgram(await this.programs.stopProgram(request), CUSTOMER) };
  }

  async paySession(request: cleaningV1.PaySessionRequest): Promise<cleaningV1.PaySessionResponse> {
    return { paymentOutcome: presentPaymentOutcome(await this.programs.paySession(request)) };
  }

  async rateSession(request: cleaningV1.RateSessionRequest): Promise<cleaningV1.RateSessionResponse> {
    return { session: presentSession(await this.programs.rateSession(request), CUSTOMER) };
  }

  // --- Lot G : réclamations (UC-NT-17) ---------------------------------------------------------
  // Dépendances injectées par propriété : le constructeur reste libre pour les autres lots.
  @Inject(CLEANING_DEPS) private readonly lotGDeps!: CleaningDeps;

  async openClaim(request: cleaningV1.OpenClaimRequest): Promise<cleaningV1.OpenClaimResponse> {
    const view = await new ClaimUseCases(this.lotGDeps).open({
      sessionId: request.sessionId,
      idempotencyKey: request.idempotencyKey,
      category: request.category,
      text: request.text,
      photoFileIds: request.photoFileIds,
    });
    return { claim: toClaim(view) };
  }

  async listMyClaims(request: cleaningV1.ListMyClaimsRequest): Promise<cleaningV1.ListMyClaimsResponse> {
    return toClaimPage(
      await new ClaimUseCases(this.lotGDeps).listMine({
        ...(request.status ? { status: request.status } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.sort ? { sort: request.sort } : {}),
      }),
    );
  }

  async getMyClaim(request: cleaningV1.GetMyClaimRequest): Promise<cleaningV1.GetMyClaimResponse> {
    return { claim: toClaim(await new ClaimUseCases(this.lotGDeps).getMine(request.claimId)) };
  }

  async addClaimMessage(
    request: cleaningV1.AddClaimMessageRequest,
  ): Promise<cleaningV1.AddClaimMessageResponse> {
    const view = await new ClaimUseCases(this.lotGDeps).addMessage({
      claimId: request.claimId,
      idempotencyKey: request.idempotencyKey,
      text: request.text,
    });
    return { claim: toClaim(view) };
  }

  // --- Piste P : renouveler, commander à nouveau (UC-NT-18) ------------------------------------
  async renewProgram(request: cleaningV1.RenewProgramRequest): Promise<cleaningV1.RenewProgramResponse> {
    const record = await new ProgramRenewalUseCases(this.lotGDeps as ExecutionDeps).renew({
      programId: request.programId,
      idempotencyKey: request.idempotencyKey,
      startDate: request.startDate,
    });
    return { request: await new CasePresenter(this.lotGDeps).request(record, CUSTOMER_CASE) };
  }

  async reorderProgram(
    request: cleaningV1.ReorderProgramRequest,
  ): Promise<cleaningV1.ReorderProgramResponse> {
    const record = await new ProgramRenewalUseCases(this.lotGDeps as ExecutionDeps).reorder({
      programId: request.programId,
      idempotencyKey: request.idempotencyKey,
      schedule: scheduleFromProto(request.schedule),
    });
    return { request: await new CasePresenter(this.lotGDeps).request(record, CUSTOMER_CASE) };
  }
}
