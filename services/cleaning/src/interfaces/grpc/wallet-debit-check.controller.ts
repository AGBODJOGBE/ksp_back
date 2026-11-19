import { cleaningV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de WalletDebitCheckService — réservé à wallet (rapprochement des débits du
 * wallet). Métier v2 livré lot par lot (ADR-054) : chaque méthode pas encore livrée répond
 * NOT_IMPLEMENTED.
 */
@Controller()
@cleaningV1.WalletDebitCheckServiceControllerMethods()
export class WalletDebitCheckGrpcController implements cleaningV1.WalletDebitCheckServiceController {
  getWalletDebitStatus(): Promise<cleaningV1.GetWalletDebitStatusResponse> {
    return notImplemented('GetWalletDebitStatus');
  }
}
