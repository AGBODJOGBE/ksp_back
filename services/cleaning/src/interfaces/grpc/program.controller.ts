import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
// Lot G
import { ClaimUseCases } from '../../application/claims/claims.use-cases';
import { CLEANING_DEPS, type CleaningDeps } from '../../application/deps';
import { toClaim, toClaimPage } from './claim.presenters';
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

  renewProgram(): Promise<cleaningV1.RenewProgramResponse> {
    return notImplemented('RenewProgram');
  }

  reorderProgram(): Promise<cleaningV1.ReorderProgramResponse> {
    return notImplemented('ReorderProgram');
  }
}
