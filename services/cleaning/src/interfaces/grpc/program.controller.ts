import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { CustomerProgramUseCases } from '../../application/execution/customer-programs.use-cases';
import { CLEANING_DEPS, type CleaningDeps, type ExecutionDeps } from '../../application/deps';
import { CUSTOMER, presentPaymentOutcome, presentProgram, presentSession } from './execution-presenters';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de ProgramService — programmes, séances, paiements, notes et réclamations du
 * client (UC-NT-11 à 18). Lot E livré : programmes et séances, report, annulation, arrêt, paiement
 * et note d'une séance. Réclamations (UC-NT-17), renouvellement et nouvelle commande (UC-NT-18)
 * arrivent avec le lot G et répondent encore NOT_IMPLEMENTED.
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

  openClaim(): Promise<cleaningV1.OpenClaimResponse> {
    return notImplemented('OpenClaim');
  }

  listMyClaims(): Promise<cleaningV1.ListMyClaimsResponse> {
    return notImplemented('ListMyClaims');
  }

  getMyClaim(): Promise<cleaningV1.GetMyClaimResponse> {
    return notImplemented('GetMyClaim');
  }

  addClaimMessage(): Promise<cleaningV1.AddClaimMessageResponse> {
    return notImplemented('AddClaimMessage');
  }

  renewProgram(): Promise<cleaningV1.RenewProgramResponse> {
    return notImplemented('RenewProgram');
  }

  reorderProgram(): Promise<cleaningV1.ReorderProgramResponse> {
    return notImplemented('ReorderProgram');
  }
}
