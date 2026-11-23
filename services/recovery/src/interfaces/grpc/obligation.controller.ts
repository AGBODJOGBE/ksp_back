import { commonV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { RECOVERY_USE_CASES, type RecoveryUseCases } from '../../application/use-cases';

/**
 * ksp.common.v1.ObligationService, interrogé par identity avant la suppression d'un compte
 * (UC-ID-11, ADR-036) : un dossier de recouvrement ouvert bloque. Le contrôle de l'appelant est fait
 * par le cas d'usage.
 */
@Controller()
@commonV1.ObligationServiceControllerMethods()
export class ObligationGrpcController implements commonV1.ObligationServiceController {
  constructor(@Inject(RECOVERY_USE_CASES) private readonly useCases: RecoveryUseCases) {}

  async hasPendingObligations(
    request: commonV1.HasPendingObligationsRequest,
  ): Promise<commonV1.HasPendingObligationsResponse> {
    const obligations = await this.useCases.hasPendingObligations.execute({
      userId: request.userId,
      organizationId: request.organizationId,
    });
    return { hasPending: obligations.length > 0, obligations };
  }
}
