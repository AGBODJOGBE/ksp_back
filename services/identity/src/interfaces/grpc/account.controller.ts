import { identityV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC du compte de l'utilisateur connecté, réservé à la gateway.
 * Aucune règle métier ici : chaque méthode appellera son cas d'usage (lot 1).
 */
@Controller()
@identityV1.AccountServiceControllerMethods()
export class AccountGrpcController implements identityV1.AccountServiceController {
  getMe(): Promise<identityV1.GetMeResponse> {
    return notImplemented('GetMe');
  }

  updateMe(): Promise<identityV1.UpdateMeResponse> {
    return notImplemented('UpdateMe');
  }
}
