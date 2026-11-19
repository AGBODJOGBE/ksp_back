import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de ProgramService — programmes, séances, paiements, notes et réclamations du
 * client (UC-NT-11 à 18). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore livrée
 * répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.ProgramServiceControllerMethods()
export class ProgramGrpcController implements cleaningV1.ProgramServiceController {
  listMyPrograms(): Promise<cleaningV1.ListMyProgramsResponse> {
    return notImplemented('ListMyPrograms');
  }

  getMyProgram(): Promise<cleaningV1.GetMyProgramResponse> {
    return notImplemented('GetMyProgram');
  }

  listMyProgramSessions(): Promise<cleaningV1.ListMyProgramSessionsResponse> {
    return notImplemented('ListMyProgramSessions');
  }

  getMySession(): Promise<cleaningV1.GetMySessionResponse> {
    return notImplemented('GetMySession');
  }

  rescheduleSession(): Promise<cleaningV1.RescheduleSessionResponse> {
    return notImplemented('RescheduleSession');
  }

  cancelSession(): Promise<cleaningV1.CancelSessionResponse> {
    return notImplemented('CancelSession');
  }

  stopProgram(): Promise<cleaningV1.StopProgramResponse> {
    return notImplemented('StopProgram');
  }

  paySession(): Promise<cleaningV1.PaySessionResponse> {
    return notImplemented('PaySession');
  }

  rateSession(): Promise<cleaningV1.RateSessionResponse> {
    return notImplemented('RateSession');
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
