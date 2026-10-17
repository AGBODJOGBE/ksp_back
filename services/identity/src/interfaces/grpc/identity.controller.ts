import { identityV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC : traduit chaque appel en cas d'usage (couche application).
 * Aucune règle métier ici.
 *
 * Fondations : le contrat est exposé, chaque méthode répond NOT_IMPLEMENTED
 * jusqu'à ce que son cas d'usage soit livré (lot 1).
 */
@Controller()
@identityV1.IdentityServiceControllerMethods()
export class IdentityGrpcController implements identityV1.IdentityServiceController {
  getUser(): Promise<identityV1.GetUserResponse> {
    return notImplemented('GetUser');
  }

  getUsersByIds(): Promise<identityV1.GetUsersByIdsResponse> {
    return notImplemented('GetUsersByIds');
  }

  checkPermission(): Promise<identityV1.CheckPermissionResponse> {
    return notImplemented('CheckPermission');
  }

  grantRole(): Promise<identityV1.GrantRoleResponse> {
    return notImplemented('GrantRole');
  }

  revokeRole(): Promise<identityV1.RevokeRoleResponse> {
    return notImplemented('RevokeRole');
  }

  registerCatalog(): Promise<identityV1.RegisterCatalogResponse> {
    return notImplemented('RegisterCatalog');
  }

  getCatalog(): Promise<identityV1.GetCatalogResponse> {
    return notImplemented('GetCatalog');
  }
}
