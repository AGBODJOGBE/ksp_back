import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { ClaimAdminUseCases } from '../../application/claims/claims.use-cases';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import { toClaim, toClaimPage } from './claim.presenters';

/**
 * Adaptateur gRPC de ClaimAdminService — back-office : réclamations (UC-NT-40, lot G).
 */
@Controller()
@cleaningV1.ClaimAdminServiceControllerMethods()
export class ClaimAdminGrpcController implements cleaningV1.ClaimAdminServiceController {
  private readonly claims: ClaimAdminUseCases;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.claims = new ClaimAdminUseCases(deps);
  }

  async listClaims(request: cleaningV1.ListClaimsRequest): Promise<cleaningV1.ListClaimsResponse> {
    return toClaimPage(
      await this.claims.list({
        ...(request.status ? { status: request.status } : {}),
        ...(request.agentId ? { agentId: request.agentId } : {}),
        ...(request.customerId ? { customerId: request.customerId } : {}),
        ...(request.organizationId ? { organizationId: request.organizationId } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        ...(request.sort ? { sort: request.sort } : {}),
      }),
    );
  }

  async getClaim(request: cleaningV1.GetClaimRequest): Promise<cleaningV1.GetClaimResponse> {
    return { claim: toClaim(await this.claims.get(request.claimId)) };
  }

  async updateClaim(request: cleaningV1.UpdateClaimRequest): Promise<cleaningV1.UpdateClaimResponse> {
    return {
      claim: toClaim(
        await this.claims.update({
          claimId: request.claimId,
          idempotencyKey: request.idempotencyKey,
          status: request.status ?? null,
          message: request.message ?? null,
        }),
      ),
    };
  }

  async decideClaim(request: cleaningV1.DecideClaimRequest): Promise<cleaningV1.DecideClaimResponse> {
    return {
      claim: toClaim(
        await this.claims.decide({
          claimId: request.claimId,
          idempotencyKey: request.idempotencyKey,
          outcome: request.outcome,
          creditAmount: request.creditAmount ? Number(request.creditAmount.amount) : null,
          reason: request.reason,
        }),
      ),
    };
  }

  async approveClaimCredit(
    request: cleaningV1.ApproveClaimCreditRequest,
  ): Promise<cleaningV1.ApproveClaimCreditResponse> {
    return {
      claim: toClaim(
        await this.claims.approveCredit({ claimId: request.claimId, idempotencyKey: request.idempotencyKey }),
      ),
    };
  }
}
