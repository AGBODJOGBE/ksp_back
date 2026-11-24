import { cleaningV1 } from '@ksp/contracts';
import { Controller, Inject } from '@nestjs/common';
import { WalletDebitStatusUseCase } from '../../application/execution/agent-activity.use-cases';
import { CLEANING_DEPS, type CleaningDeps, type ExecutionDeps } from '../../application/deps';

/**
 * Adaptateur gRPC de WalletDebitCheckService — réservé à wallet (rapprochement des débits du
 * wallet, RV-80) : un débit cité par un objet est « enregistré », une opération en cours ne se
 * rembourse pas.
 */
@Controller()
@cleaningV1.WalletDebitCheckServiceControllerMethods()
export class WalletDebitCheckGrpcController implements cleaningV1.WalletDebitCheckServiceController {
  private readonly status: WalletDebitStatusUseCase;

  constructor(@Inject(CLEANING_DEPS) deps: CleaningDeps) {
    this.status = new WalletDebitStatusUseCase(deps as ExecutionDeps);
  }

  getWalletDebitStatus(
    request: cleaningV1.GetWalletDebitStatusRequest,
  ): Promise<cleaningV1.GetWalletDebitStatusResponse> {
    return this.status.execute(request);
  }
}
