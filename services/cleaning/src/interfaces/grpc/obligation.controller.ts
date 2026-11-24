import { commonV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { CLEANING_DEPS, type CleaningDeps, type PrivacyDeps } from '../../application/deps';
import { HasPendingObligationsUseCase } from '../../application/privacy/obligations.use-case';

/**
 * ksp.common.v1.ObligationService, appelé par identity avant la suppression d'un compte, puis de
 * nouveau juste avant son anonymisation (ADR-036) : une demande ouverte, un programme non terminé,
 * une séance impayée, un paiement en cours ou, pour un agent, une affectation à venir la bloque.
 * Le contrôle de l'appelant (identity seul, sinon CLEANING_CALLER_FORBIDDEN) est fait par le cas
 * d'usage. Une erreur de lecture répond une erreur : identity refuse alors la suppression.
 */
@Controller()
@commonV1.ObligationServiceControllerMethods()
export class ObligationGrpcController implements commonV1.ObligationServiceController {
  private readonly obligations: HasPendingObligationsUseCase;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.obligations = new HasPendingObligationsUseCase(deps as PrivacyDeps);
  }

  async hasPendingObligations(
    request: commonV1.HasPendingObligationsRequest,
  ): Promise<commonV1.HasPendingObligationsResponse> {
    const obligations = await this.obligations.execute({
      userId: request.userId,
      organizationId: request.organizationId,
    });
    return { hasPending: obligations.length > 0, obligations };
  }
}
