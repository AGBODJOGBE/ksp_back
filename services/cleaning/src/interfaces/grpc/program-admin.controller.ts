import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import {
  AdminProgramUseCases,
  canReadAmounts,
  type StaffSessionDetails,
} from '../../application/execution/admin-programs.use-cases';
import { CLEANING_DEPS, type CleaningDeps, type ExecutionDeps } from '../../application/deps';
import { type Audience, presentProgram, presentResumption, presentSession } from './execution-presenters';
// Piste P
import { ProgramAmendmentUseCases } from '../../application/requests/program-amendment.use-cases';
import { seesAmounts } from '../../application/requests/staff';
import { CasePresenter } from './case.presenters';
import { declaredFromProto } from './case-values.presenters';
import { scheduleFromProto } from './simulation.presenters';

/**
 * Adaptateur gRPC de ProgramAdminService — back-office : programmes et séances (UC-NT-39). Lot E
 * livré : lecture, suspension et reprise, arrêt par KSP et sa validation, report, annulation et
 * reprise d'une séance, clôture et absence enregistrées pour l'équipe, retrait d'une photo. Piste P :
 * changement de plan et avenant (R-PG-06).
 */
const staff = (): Audience => ({ amounts: canReadAmounts(), staff: true });
const session = (details: StaffSessionDetails) =>
  presentSession(details, { amounts: details.showAmounts, staff: true });

@Controller()
@cleaningV1.ProgramAdminServiceControllerMethods()
export class ProgramAdminGrpcController implements cleaningV1.ProgramAdminServiceController {
  private readonly programs: AdminProgramUseCases;
  // Piste P : avenant.
  private readonly amendments: ProgramAmendmentUseCases;
  private readonly cases: CasePresenter;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.programs = new AdminProgramUseCases(deps as ExecutionDeps);
    this.amendments = new ProgramAmendmentUseCases(deps as ExecutionDeps);
    this.cases = new CasePresenter(deps);
  }

  async listPrograms(request: cleaningV1.ListProgramsRequest): Promise<cleaningV1.ListProgramsResponse> {
    const page = await this.programs.listPrograms(request);
    const audience = staff();
    return {
      items: page.items.map((program) => presentProgram(program, audience)),
      nextCursor: page.nextCursor ?? '',
      total: page.total,
    };
  }

  async getProgram(request: cleaningV1.GetProgramRequest): Promise<cleaningV1.GetProgramResponse> {
    return { program: presentProgram(await this.programs.getProgram(request.programId), staff()) };
  }

  async listProgramSessions(
    request: cleaningV1.ListProgramSessionsRequest,
  ): Promise<cleaningV1.ListProgramSessionsResponse> {
    const page = await this.programs.listSessions(request);
    return { items: page.items.map(session), nextCursor: page.nextCursor ?? '', total: page.total };
  }

  async getSession(request: cleaningV1.GetSessionRequest): Promise<cleaningV1.GetSessionResponse> {
    return { session: session(await this.programs.getSession(request.sessionId)) };
  }

  async changeProgramSchedule(
    request: cleaningV1.ChangeProgramScheduleRequest,
  ): Promise<cleaningV1.ChangeProgramScheduleResponse> {
    const program = await this.programs.changeProgramSchedule({
      programId: request.programId,
      idempotencyKey: request.idempotencyKey,
      effectiveFrom: request.effectiveFrom,
      schedule: scheduleFromProto(request.schedule),
      reason: request.reason,
      durationMinutes: request.durationMinutes ?? null,
    });
    return { program: presentProgram(program, staff()) };
  }

  /** Piste P — R-PG-06 : devis d'avenant, brouillon, sur la demande du programme. */
  async createAmendment(
    request: cleaningV1.CreateAmendmentRequest,
  ): Promise<cleaningV1.CreateAmendmentResponse> {
    const { record, quote } = await this.amendments.create({
      programId: request.programId,
      idempotencyKey: request.idempotencyKey,
      addCleaningTypeIds: request.addCleaningTypeIds,
      addSchedule: scheduleFromProto(request.addSchedule),
      values: declaredFromProto(request.values),
      teamSize: request.teamSize,
      durationMinutes: request.durationMinutes,
      adjustments: request.adjustments.map((item) => ({
        kind: item.kind,
        percentBps: item.percentBps,
        fixedAmount: item.fixedAmount ? Number(item.fixedAmount.amount) : undefined,
        reason: item.reason,
      })),
      onQuotePrices: request.onQuotePrices.map((item) => ({
        offerId: item.offerId,
        price: Number(item.price?.amount ?? 0),
      })),
      validityDays: request.validityDays,
    });
    const audience = { kind: 'staff' as const, amounts: seesAmounts(record.request.communeKey) };
    return { quote: await this.cases.quoteView(record, quote, audience) };
  }

  async suspendProgram(
    request: cleaningV1.SuspendProgramRequest,
  ): Promise<cleaningV1.SuspendProgramResponse> {
    return { program: presentProgram(await this.programs.suspendProgram(request), staff()) };
  }

  async resumeProgram(request: cleaningV1.ResumeProgramRequest): Promise<cleaningV1.ResumeProgramResponse> {
    return { programResumption: presentResumption(await this.programs.resumeProgram(request), staff()) };
  }

  async cancelProgram(request: cleaningV1.CancelProgramRequest): Promise<cleaningV1.CancelProgramResponse> {
    return { program: presentProgram(await this.programs.cancelProgram(request), staff()) };
  }

  async approveProgramCancellation(
    request: cleaningV1.ApproveProgramCancellationRequest,
  ): Promise<cleaningV1.ApproveProgramCancellationResponse> {
    return { program: presentProgram(await this.programs.approveProgramCancellation(request), staff()) };
  }

  async rescheduleSessionAsKsp(
    request: cleaningV1.RescheduleSessionAsKspRequest,
  ): Promise<cleaningV1.RescheduleSessionAsKspResponse> {
    return { session: session(await this.programs.rescheduleSession(request)) };
  }

  async cancelSessionAsKsp(
    request: cleaningV1.CancelSessionAsKspRequest,
  ): Promise<cleaningV1.CancelSessionAsKspResponse> {
    return { session: session(await this.programs.cancelSession(request)) };
  }

  async resumeSession(request: cleaningV1.ResumeSessionRequest): Promise<cleaningV1.ResumeSessionResponse> {
    return { session: session(await this.programs.resumeSession(request)) };
  }

  async completeSessionAsKsp(
    request: cleaningV1.CompleteSessionAsKspRequest,
  ): Promise<cleaningV1.CompleteSessionAsKspResponse> {
    return { session: session(await this.programs.completeSession(request)) };
  }

  async reportSessionMissedAsKsp(
    request: cleaningV1.ReportSessionMissedAsKspRequest,
  ): Promise<cleaningV1.ReportSessionMissedAsKspResponse> {
    return { session: session(await this.programs.reportSessionMissed(request)) };
  }

  async removeSessionPhotoAsKsp(
    request: cleaningV1.RemoveSessionPhotoAsKspRequest,
  ): Promise<cleaningV1.RemoveSessionPhotoAsKspResponse> {
    return { session: session(await this.programs.removePhoto(request)) };
  }
}
