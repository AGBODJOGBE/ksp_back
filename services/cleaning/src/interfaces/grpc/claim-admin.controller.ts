import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de ClaimAdminService — back-office : réclamations (UC-NT-40). Métier v2 livré lot
 * par lot (ADR-054) : chaque méthode pas encore livrée répond NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.ClaimAdminServiceControllerMethods()
export class ClaimAdminGrpcController implements cleaningV1.ClaimAdminServiceController {
  listClaims(): Promise<cleaningV1.ListClaimsResponse> {
    return notImplemented('ListClaims');
  }

  getClaim(): Promise<cleaningV1.GetClaimResponse> {
    return notImplemented('GetClaim');
  }

  updateClaim(): Promise<cleaningV1.UpdateClaimResponse> {
    return notImplemented('UpdateClaim');
  }

  decideClaim(): Promise<cleaningV1.DecideClaimResponse> {
    return notImplemented('DecideClaim');
  }

  approveClaimCredit(): Promise<cleaningV1.ApproveClaimCreditResponse> {
    return notImplemented('ApproveClaimCredit');
  }
}
