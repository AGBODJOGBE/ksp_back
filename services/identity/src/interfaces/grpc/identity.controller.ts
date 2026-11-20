import { identityV1 } from '@ksp/contracts';
import { currentContext } from '@ksp/platform';
import { Controller } from '@nestjs/common';
import { GetOrganizationsUseCase } from '../../application/directory/get-organizations.use-case';
import { GetUsersUseCase } from '../../application/directory/get-users.use-case';
import { GetCatalogUseCase, RegisterCatalogUseCase } from '../../application/rbac/catalog.use-cases';
import {
  CheckPermissionUseCase,
  GrantRoleUseCase,
  ListStaffByPermissionUseCase,
  RevokeRoleUseCase,
} from '../../application/rbac/service-roles.use-cases';
import { type RoleScopeType } from '../../domain/role/role';
import { toPermissionMessage } from './account-admin.controller';
import { toOrganizationProfileMessage, toUserMessage } from './mappers';

const SCOPE_TYPE: Record<RoleScopeType, identityV1.ScopeType> = {
  global: identityV1.ScopeType.SCOPE_TYPE_GLOBAL,
  domain: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
  org: identityV1.ScopeType.SCOPE_TYPE_ORG,
  personal: identityV1.ScopeType.SCOPE_TYPE_PERSONAL,
  zone: identityV1.ScopeType.SCOPE_TYPE_ZONE,
};
const SCOPE_TYPE_IN = new Map<identityV1.ScopeType, RoleScopeType>(
  Object.entries(SCOPE_TYPE).map(([name, value]) => [value, name as RoleScopeType]),
);

/**
 * Adaptateur gRPC : traduit chaque appel en cas d'usage (couche application).
 * Aucune règle métier ici.
 *
 * GetUser et GetUsersByIds servent notification (destinataires des événements métier, lot 2) ;
 * GetOrganizationsByIds sert billing (en-tête des factures) et notification (e-mail de facturation).
 * Rôles et permissions (ADR-057) : catalogue déclaré par chaque service, attribution par cleaning,
 * personnel à prévenir pour notification, contrôle à jour des actions sensibles.
 */
@Controller()
@identityV1.IdentityServiceControllerMethods()
export class IdentityGrpcController implements identityV1.IdentityServiceController {
  constructor(
    private readonly getUsersUseCase: GetUsersUseCase,
    private readonly getOrganizationsUseCase: GetOrganizationsUseCase,
    private readonly registerCatalogUseCase: RegisterCatalogUseCase,
    private readonly getCatalogUseCase: GetCatalogUseCase,
    private readonly grantRoleUseCase: GrantRoleUseCase,
    private readonly revokeRoleUseCase: RevokeRoleUseCase,
    private readonly listStaffByPermissionUseCase: ListStaffByPermissionUseCase,
    private readonly checkPermissionUseCase: CheckPermissionUseCase,
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

  async listStaffByPermission(
    request: identityV1.ListStaffByPermissionRequest,
  ): Promise<identityV1.ListStaffByPermissionResponse> {
    const userIds = await this.listStaffByPermissionUseCase.execute(callerService(), {
      permission: request.permission,
      zoneKey: request.zoneKey,
    });
    return { userIds };
  }

  async checkPermission(
    request: identityV1.CheckPermissionRequest,
  ): Promise<identityV1.CheckPermissionResponse> {
    return this.checkPermissionUseCase.execute({
      userId: request.userId,
      permission: request.permission,
      scopeType: SCOPE_TYPE_IN.get(request.scopeType) ?? null,
      scopeId: request.scopeId,
    });
  }

  async grantRole(request: identityV1.GrantRoleRequest): Promise<identityV1.GrantRoleResponse> {
    const grant = await this.grantRoleUseCase.execute(callerService(), {
      userId: request.userId,
      roleCode: request.roleCode,
      reason: request.reason,
      ...(request.zones ? { zoneKeys: request.zones.keys } : {}),
    });
    return {
      assignment: {
        id: grant.assignmentId,
        userId: grant.userId,
        roleCode: grant.roleCode,
        scopeType: SCOPE_TYPE[grant.scopeType],
        scopeId: grant.scopeId ?? '',
        grantedBy: callerService() ?? 'system',
        grantedAt: grant.grantedAt.toISOString(),
        ...(grant.zoneKeys.length ? { zones: { keys: grant.zoneKeys } } : {}),
      },
    };
  }

  async revokeRole(request: identityV1.RevokeRoleRequest): Promise<identityV1.RevokeRoleResponse> {
    await this.revokeRoleUseCase.execute(callerService(), {
      assignmentId: request.assignmentId,
      reason: request.reason,
    });
    return {};
  }

  async registerCatalog(
    request: identityV1.RegisterCatalogRequest,
  ): Promise<identityV1.RegisterCatalogResponse> {
    const result = await this.registerCatalogUseCase.execute(callerService(), {
      service: request.service,
      version: request.catalogVersion,
      permissions: request.permissions.map((permission) => ({
        code: permission.code,
        description: permission.description,
      })),
      roles: request.roles.map((role) => ({
        code: role.code,
        name: role.name,
        description: role.description,
        scopeType: SCOPE_TYPE_IN.get(role.scopeType) ?? 'personal',
        requiresMfa: role.requiresMfa,
        backofficeAccess: role.backofficeAccess,
        sensitive: role.sensitive,
        permissions: role.permissions,
      })),
    });
    return { accepted: true, ...result };
  }

  async getCatalog(request: identityV1.GetCatalogRequest): Promise<identityV1.GetCatalogResponse> {
    const catalog = await this.getCatalogUseCase.execute(request.service);
    return {
      permissions: catalog.permissions.map(toPermissionMessage),
      roles: catalog.roles.map((role) => ({
        code: role.code,
        scopeType: SCOPE_TYPE[role.scopeType],
        requiresMfa: role.requiresMfa,
        description: role.description,
        permissions: role.permissions,
        name: role.name,
        sensitive: role.sensitive,
        backofficeAccess: role.backofficeAccess,
      })),
    };
  }
}

/** Renseigné par le kit après vérification du jeton de service ; absent sans vérificateur (développement). */
function callerService(): string | null {
  return currentContext()?.callerService ?? null;
}
