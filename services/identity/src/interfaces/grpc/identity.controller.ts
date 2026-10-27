import { identityV1 } from '@ksp/contracts';
import { currentContext } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { GetOrganizationsUseCase } from '../../application/directory/get-organizations.use-case';
import { GetUsersUseCase } from '../../application/directory/get-users.use-case';
import { toOrganizationProfileMessage, toUserMessage } from './mappers';
import { notImplemented } from './not-implemented';

/**
 * Adaptateur gRPC : traduit chaque appel en cas d'usage (couche application).
 * Aucune règle métier ici.
 *
 * Les méthodes pas encore livrées répondent NOT_IMPLEMENTED. GetUser et GetUsersByIds servent
 * notification (destinataires des événements métier, lot 2) ; GetOrganizationsByIds sert billing
 * (en-tête des factures) et notification (e-mail de facturation).
 */
@Controller()
@identityV1.IdentityServiceControllerMethods()
export class IdentityGrpcController implements identityV1.IdentityServiceController {
  constructor(
    private readonly getUsersUseCase: GetUsersUseCase,
    private readonly getOrganizationsUseCase: GetOrganizationsUseCase,
  ) {}

  async getUser(request: identityV1.GetUserRequest): Promise<identityV1.GetUserResponse> {
    const account = await this.getUsersUseCase.one(callerService(), request.userId);
    return { user: toUserMessage(account) };
  }

  async getUsersByIds(request: identityV1.GetUsersByIdsRequest): Promise<identityV1.GetUsersByIdsResponse> {
    const accounts = await this.getUsersUseCase.many(callerService(), request.userIds);
    return { users: accounts.map(toUserMessage) };
  }

  async getOrganizationsByIds(
    request: identityV1.GetOrganizationsByIdsRequest,
  ): Promise<identityV1.GetOrganizationsByIdsResponse> {
    const organizations = await this.getOrganizationsUseCase.many(callerService(), request.organizationIds);
    return { organizations: organizations.map(toOrganizationProfileMessage) };
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

/** Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur (développement). */
function callerService(): string | null {
  return currentContext()?.callerService ?? null;
}
