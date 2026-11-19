import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de ProgramAdminService — back-office : programmes et séances (UC-NT-39). Métier
 * v2 livré lot par lot (ADR-054) : chaque méthode pas encore livrée répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.ProgramAdminServiceControllerMethods()
export class ProgramAdminGrpcController implements cleaningV1.ProgramAdminServiceController {
  listPrograms(): Promise<cleaningV1.ListProgramsResponse> {
    return notImplemented('ListPrograms');
  }

  getProgram(): Promise<cleaningV1.GetProgramResponse> {
    return notImplemented('GetProgram');
  }

  listProgramSessions(): Promise<cleaningV1.ListProgramSessionsResponse> {
    return notImplemented('ListProgramSessions');
  }

  getSession(): Promise<cleaningV1.GetSessionResponse> {
    return notImplemented('GetSession');
  }

  changeProgramSchedule(): Promise<cleaningV1.ChangeProgramScheduleResponse> {
    return notImplemented('ChangeProgramSchedule');
  }

  createAmendment(): Promise<cleaningV1.CreateAmendmentResponse> {
    return notImplemented('CreateAmendment');
  }

  suspendProgram(): Promise<cleaningV1.SuspendProgramResponse> {
    return notImplemented('SuspendProgram');
  }

  resumeProgram(): Promise<cleaningV1.ResumeProgramResponse> {
    return notImplemented('ResumeProgram');
  }

  cancelProgram(): Promise<cleaningV1.CancelProgramResponse> {
    return notImplemented('CancelProgram');
  }

  approveProgramCancellation(): Promise<cleaningV1.ApproveProgramCancellationResponse> {
    return notImplemented('ApproveProgramCancellation');
  }

  rescheduleSessionAsKsp(): Promise<cleaningV1.RescheduleSessionAsKspResponse> {
    return notImplemented('RescheduleSessionAsKsp');
  }

  cancelSessionAsKsp(): Promise<cleaningV1.CancelSessionAsKspResponse> {
    return notImplemented('CancelSessionAsKsp');
  }

  resumeSession(): Promise<cleaningV1.ResumeSessionResponse> {
    return notImplemented('ResumeSession');
  }

  completeSessionAsKsp(): Promise<cleaningV1.CompleteSessionAsKspResponse> {
    return notImplemented('CompleteSessionAsKsp');
  }

  reportSessionMissedAsKsp(): Promise<cleaningV1.ReportSessionMissedAsKspResponse> {
    return notImplemented('ReportSessionMissedAsKsp');
  }

  removeSessionPhotoAsKsp(): Promise<cleaningV1.RemoveSessionPhotoAsKspResponse> {
    return notImplemented('RemoveSessionPhotoAsKsp');
  }
}
