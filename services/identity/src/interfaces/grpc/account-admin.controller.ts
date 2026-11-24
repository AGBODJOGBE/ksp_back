import { AllowedCallers } from '@ksp/platform';
import { identityV1 } from '@ksp/contracts';
import { Controller } from '@nestjs/common';
import { FindAccountByPhoneUseCase } from '../../application/account-admin/find-account-by-phone.use-case';
import {
  type AccountDetailView,
  type AdminAccountOutput,
  ChangeAccountStatusUseCase,
  GetAccountUseCase,
  GrantAccountRoleUseCase,
  ListAssignableRolesUseCase,
  ResetAccountMfaUseCase,
  RevokeAccountRoleUseCase,
  SearchAccountsUseCase,
} from '../../application/account-admin/account-admin.use-cases';
import { type DeclaredPermission } from '../../application/rbac/rbac.ports';
import { ListPermissionsUseCase } from '../../application/rbac/catalog.use-cases';
import {
  CreateRoleUseCase,
  DeactivateRoleUseCase,
  GetRoleUseCase,
  type ManagedRoleOutput,
  UpdateRoleUseCase,
} from '../../application/rbac/managed-roles.use-cases';
import { permissionModule } from '../../domain/role/permission';
import { type RoleScopeType } from '../../domain/role/role';
import { USER_STATUS } from './mappers';

const SCOPE_TYPE: Record<RoleScopeType, identityV1.ScopeType> = {
  global: identityV1.ScopeType.SCOPE_TYPE_GLOBAL,
  domain: identityV1.ScopeType.SCOPE_TYPE_DOMAIN,
  org: identityV1.ScopeType.SCOPE_TYPE_ORG,
  personal: identityV1.ScopeType.SCOPE_TYPE_PERSONAL,
  zone: identityV1.ScopeType.SCOPE_TYPE_ZONE,
};

const iso = (value: Date | null): string => value?.toISOString() ?? '';

function toAdminAccountMessage(account: AdminAccountOutput): identityV1.AdminAccount {
  return {
    userId: account.id,
    status: USER_STATUS[account.status],
    firstName: account.firstName ?? '',
    lastName: account.lastName ?? '',
    phoneE164: account.phoneE164 ?? '',
    phoneMasked: account.phoneMasked ?? '',
    createdAt: account.createdAt.toISOString(),
    suspendedAt: iso(account.suspendedAt),
    suspensionReason: account.suspensionReason ?? '',
    roleCodes: account.roleCodes,
  };
}

/** Fiche d'un compte → message AccountDetail (chaîne vide pour une valeur absente). */
export function toAccountDetailMessage(detail: AccountDetailView): identityV1.AccountDetail {
  return {
    account: toAdminAccountMessage(detail.account),
    mfa: {
      configured: detail.mfa.configuredAt !== null,
      configuredAt: iso(detail.mfa.configuredAt),
      recoveryCodesRemaining: detail.mfa.recoveryCodesRemaining,
    },
    roles: detail.roles.map((assignment) => ({
      id: assignment.id,
      roleCode: assignment.role.code,
      roleDescription: assignment.role.description,
      service: assignment.role.service,
      scopeType: SCOPE_TYPE[assignment.scopeType],
      scopeId: assignment.scopeId ?? '',
      grantedAt: assignment.grantedAt.toISOString(),
      grantedBy: assignment.grantedBy ?? '',
      grantedByName: assignment.grantedByName ?? '',
      grantReason: assignment.grantReason ?? '',
      revokedAt: iso(assignment.revokedAt),
      revokedBy: assignment.revokedBy ?? '',
      revokedByName: assignment.revokedByName ?? '',
      revokeReason: assignment.revokeReason ?? '',
      revocable: assignment.revocable,
      ...(assignment.zoneKeys.length ? { zones: { keys: assignment.zoneKeys } } : {}),
    })),
    history: detail.history.map((entry) => ({
      id: entry.id,
      action: entry.action,
      at: entry.at.toISOString(),
      actorId: entry.actorId,
      actorName: entry.actorName ?? '',
      roleCode: entry.roleCode ?? '',
      reason: entry.reason ?? '',
    })),
    actions: { ...detail.actions },
  };
}

/** Permission déclarée → message Permission (module : deuxième segment du code). */
export function toPermissionMessage(permission: DeclaredPermission): identityV1.Permission {
  return {
    code: permission.code,
    description: permission.description,
    service: permission.service,
    module: permissionModule(permission.code),
    retired: permission.retired,
  };
}

/** Fiche d'un rôle géré → message ManagedRole. */
export function toManagedRoleMessage(role: ManagedRoleOutput): identityV1.ManagedRole {
  return {
    code: role.code,
    name: role.name,
    description: role.description,
    service: role.service,
    origin: role.origin,
    scopeType: SCOPE_TYPE[role.scopeType],
    permissions: role.permissions,
    sensitive: role.sensitive,
    backofficeAccess: role.backofficeAccess,
    requiresMfa: role.requiresMfa,
    active: role.active,
    editable: role.editable,
    activeAssignments: role.activeAssignments,
    createdAt: role.createdAt.toISOString(),
    createdBy: role.createdBy ?? '',
    updatedAt: iso(role.updatedAt),
    updatedBy: role.updatedBy ?? '',
    deactivatedAt: iso(role.deactivatedAt),
    deactivatedBy: role.deactivatedBy ?? '',
  };
}

/**
 * Adaptateur gRPC de l'administration des comptes au back-office (ADR-029, ADR-043), réservé à la
 * gateway. Rôles, double authentification et périmètre revérifiés par les cas d'usage.
 */
@Controller()
@AllowedCallers('gateway')
@identityV1.AccountAdminServiceControllerMethods()
export class AccountAdminGrpcController implements identityV1.AccountAdminServiceController {
  constructor(
    private readonly findAccountByPhoneUseCase: FindAccountByPhoneUseCase,
    private readonly searchAccountsUseCase: SearchAccountsUseCase,
    private readonly getAccountUseCase: GetAccountUseCase,
    private readonly listAssignableRolesUseCase: ListAssignableRolesUseCase,
    private readonly grantAccountRoleUseCase: GrantAccountRoleUseCase,
    private readonly revokeAccountRoleUseCase: RevokeAccountRoleUseCase,
    private readonly changeAccountStatusUseCase: ChangeAccountStatusUseCase,
    private readonly resetAccountMfaUseCase: ResetAccountMfaUseCase,
    private readonly listPermissionsUseCase: ListPermissionsUseCase,
    private readonly getRoleUseCase: GetRoleUseCase,
    private readonly createRoleUseCase: CreateRoleUseCase,
    private readonly updateRoleUseCase: UpdateRoleUseCase,
    private readonly deactivateRoleUseCase: DeactivateRoleUseCase,
  ) {}

  async findAccountByPhone(
    request: identityV1.FindAccountByPhoneRequest,
  ): Promise<identityV1.FindAccountByPhoneResponse> {
    const match = await this.findAccountByPhoneUseCase.execute({ phone: request.phoneE164 });
    return {
      account: {
        userId: match.userId,
        status: USER_STATUS[match.status],
        firstName: match.firstName ?? '',
        lastName: match.lastName ?? '',
        phoneMasked: match.phoneMasked,
      },
    };
  }

  async searchAccounts(
    request: identityV1.SearchAccountsRequest,
  ): Promise<identityV1.SearchAccountsResponse> {
    const page = await this.searchAccountsUseCase.execute({
      query: request.query,
      limit: request.limit,
      cursor: request.cursor,
    });
    return { accounts: page.items.map(toAdminAccountMessage), nextCursor: page.nextCursor ?? '' };
  }

  async getAccount(request: identityV1.GetAccountRequest): Promise<identityV1.GetAccountResponse> {
    return { detail: toAccountDetailMessage(await this.getAccountUseCase.execute(request.userId)) };
  }

  async listAssignableRoles(): Promise<identityV1.ListAssignableRolesResponse> {
    const roles = await this.listAssignableRolesUseCase.execute();
    return {
      roles: roles.map((role) => ({
        code: role.code,
        service: role.service,
        scopeType: SCOPE_TYPE[role.scopeType],
        description: role.description,
        backofficeAccess: role.backofficeAccess,
        grantable: role.grantable,
        name: role.name || role.code,
        active: role.active !== false,
        sensitive: role.sensitive === true,
        origin: role.origin ?? 'default',
      })),
    };
  }

  async grantAccountRole(
    request: identityV1.GrantAccountRoleRequest,
  ): Promise<identityV1.GrantAccountRoleResponse> {
    const detail = await this.grantAccountRoleUseCase.execute({
      userId: request.userId,
      roleCode: request.roleCode,
      reason: request.reason,
      ...(request.zones ? { zoneKeys: request.zones.keys } : {}),
    });
    return { detail: toAccountDetailMessage(detail) };
  }

  async revokeAccountRole(
    request: identityV1.RevokeAccountRoleRequest,
  ): Promise<identityV1.RevokeAccountRoleResponse> {
    const detail = await this.revokeAccountRoleUseCase.execute({
      userId: request.userId,
      assignmentId: request.assignmentId,
      reason: request.reason,
    });
    return { detail: toAccountDetailMessage(detail) };
  }

  async suspendAccount(
    request: identityV1.SuspendAccountRequest,
  ): Promise<identityV1.SuspendAccountResponse> {
    const detail = await this.changeAccountStatusUseCase.execute({
      userId: request.userId,
      action: 'suspend',
      reason: request.reason,
    });
    return { detail: toAccountDetailMessage(detail) };
  }

  async reactivateAccount(
    request: identityV1.ReactivateAccountRequest,
  ): Promise<identityV1.ReactivateAccountResponse> {
    const detail = await this.changeAccountStatusUseCase.execute({
      userId: request.userId,
      action: 'reactivate',
      reason: request.reason,
    });
    return { detail: toAccountDetailMessage(detail) };
  }

  async resetAccountMfa(
    request: identityV1.ResetAccountMfaRequest,
  ): Promise<identityV1.ResetAccountMfaResponse> {
    const detail = await this.resetAccountMfaUseCase.execute({
      userId: request.userId,
      reason: request.reason,
    });
    return { detail: toAccountDetailMessage(detail) };
  }

  async listPermissions(
    request: identityV1.ListPermissionsRequest,
  ): Promise<identityV1.ListPermissionsResponse> {
    const permissions = await this.listPermissionsUseCase.execute({
      service: request.service,
      includeRetired: request.includeRetired,
    });
    return { permissions: permissions.map(toPermissionMessage) };
  }

  async getRole(request: identityV1.GetRoleRequest): Promise<identityV1.GetRoleResponse> {
    return { role: toManagedRoleMessage(await this.getRoleUseCase.execute(request.roleCode)) };
  }

  async createRole(request: identityV1.CreateRoleRequest): Promise<identityV1.CreateRoleResponse> {
    const role = await this.createRoleUseCase.execute({
      code: request.code,
      name: request.name,
      description: request.description,
      permissions: request.permissions,
      sensitive: request.sensitive,
      reason: request.reason,
    });
    return { role: toManagedRoleMessage(role) };
  }

  async updateRole(request: identityV1.UpdateRoleRequest): Promise<identityV1.UpdateRoleResponse> {
    const role = await this.updateRoleUseCase.execute({
      code: request.roleCode,
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.sensitive !== undefined ? { sensitive: request.sensitive } : {}),
      // Absent : permissions inchangées ; présent (même vide) : liste complète.
      ...(request.permissions ? { permissions: request.permissions.codes } : {}),
      reason: request.reason,
    });
    return { role: toManagedRoleMessage(role) };
  }

  async deactivateRole(
    request: identityV1.DeactivateRoleRequest,
  ): Promise<identityV1.DeactivateRoleResponse> {
    const role = await this.deactivateRoleUseCase.execute({ code: request.roleCode, reason: request.reason });
    return { role: toManagedRoleMessage(role) };
  }
}
