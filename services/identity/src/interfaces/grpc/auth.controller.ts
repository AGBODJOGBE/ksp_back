import { identityV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC de la connexion et des sessions, réservé à la gateway.
 * Aucune règle métier ici : chaque méthode appellera son cas d'usage (lot 1).
 */
@Controller()
@identityV1.AuthServiceControllerMethods()
export class AuthGrpcController implements identityV1.AuthServiceController {
  requestOtp(): Promise<identityV1.RequestOtpResponse> {
    return notImplemented('RequestOtp');
  }

  verifyOtp(): Promise<identityV1.VerifyOtpResponse> {
    return notImplemented('VerifyOtp');
  }

  refreshSession(): Promise<identityV1.RefreshSessionResponse> {
    return notImplemented('RefreshSession');
  }

  logout(): Promise<identityV1.LogoutResponse> {
    return notImplemented('Logout');
  }

  getSigningKeys(): Promise<identityV1.GetSigningKeysResponse> {
    return notImplemented('GetSigningKeys');
  }
}
