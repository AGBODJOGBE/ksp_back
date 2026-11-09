import { type Metadata } from '@grpc/grpc-js';
import { identityV1 } from '@ksp/contracts';
import { AppError, type GrpcCaller } from '@ksp/platform';
import { Logger } from '@nestjs/common';
import { type Observable } from 'rxjs';
import {
  type AccountAdminApi,
  type AccountStatusAction,
} from '../../application/identity/account-admin.ports';
import { type Json } from '../../application/cleaning/cleaning.ports';
import { USER_STATUS } from './identity-grpc.adapter';
import { toUpstreamError } from './upstream-error';

/** Réponse d'identity qui ne respecte pas le contrat : erreur interne, jamais transmise telle quelle. */
const malformed = (what: string) =>
  new AppError('INTERNAL', 'GATEWAY_UPSTREAM_ERROR', `Réponse d'identity inattendue (${what}).`);
const orNull = (value: string | undefined): string | null => (value ? value : null);

const SCOPE_TYPE: Partial<Record<identityV1.ScopeType, string>> = {
  [identityV1.ScopeType.SCOPE_TYPE_GLOBAL]: 'global',
  [identityV1.ScopeType.SCOPE_TYPE_DOMAIN]: 'domain',
  [identityV1.ScopeType.SCOPE_TYPE_ORG]: 'org',
  [identityV1.ScopeType.SCOPE_TYPE_PERSONAL]: 'personal',
};

function userStatus(value: identityV1.UserStatus): string {
  const status = USER_STATUS[value];
  if (!status) throw malformed(`état ${value}`);
  return status;
}

function scopeType(value: identityV1.ScopeType): string {
  const scope = SCOPE_TYPE[value];
  if (!scope) throw malformed(`portée ${value}`);
  return scope;
}

/** Compte trouvé, au format du contrat OpenAPI (AdminAccountMatch). */
export function presentAccountMatch(value: identityV1.AccountMatch | undefined) {
  if (!value) throw malformed('compte');
  return {
    userId: value.userId,
    status: userStatus(value.status),
    firstName: orNull(value.firstName),
    lastName: orNull(value.lastName),
    phoneMasked: value.phoneMasked,
  };
}

/** Compte vu par l'administration (AdminAccount). */
export function presentAdminAccount(value: identityV1.AdminAccount | undefined) {
  if (!value) throw malformed('compte');
  return {
    userId: value.userId,
    status: userStatus(value.status),
    firstName: orNull(value.firstName),
    lastName: orNull(value.lastName),
    phone: orNull(value.phoneE164),
    phoneMasked: orNull(value.phoneMasked),
    createdAt: value.createdAt,
    suspendedAt: orNull(value.suspendedAt),
    suspensionReason: orNull(value.suspensionReason),
    roles: value.roleCodes,
  };
}

/** Fiche d'un compte (AdminAccountDetail). */
export function presentAccountDetail(value: identityV1.AccountDetail | undefined) {
  if (!value?.mfa || !value.actions) throw malformed('fiche');
  return {
    account: presentAdminAccount(value.account),
    mfa: {
      configured: value.mfa.configured,
      configuredAt: orNull(value.mfa.configuredAt),
      recoveryCodesRemaining: value.mfa.recoveryCodesRemaining,
    },
    roles: value.roles.map((role) => ({
      id: role.id,
      roleCode: role.roleCode,
      roleDescription: role.roleDescription,
      service: role.service,
      scopeType: scopeType(role.scopeType),
      scopeId: orNull(role.scopeId),
      grantedAt: role.grantedAt,
      grantedBy: orNull(role.grantedBy),
      grantedByName: orNull(role.grantedByName),
      grantReason: orNull(role.grantReason),
      revokedAt: orNull(role.revokedAt),
      revokedBy: orNull(role.revokedBy),
      revokedByName: orNull(role.revokedByName),
      revokeReason: orNull(role.revokeReason),
      revocable: role.revocable,
    })),
    history: value.history.map((entry) => ({
      id: entry.id,
      action: entry.action,
      at: entry.at,
      actorId: entry.actorId,
      actorName: orNull(entry.actorName),
      roleCode: orNull(entry.roleCode),
      reason: orNull(entry.reason),
    })),
    actions: {
      grantRole: value.actions.grantRole,
      suspend: value.actions.suspend,
      reactivate: value.actions.reactivate,
      resetMfa: value.actions.resetMfa,
    },
  };
}

/**
 * Client gRPC des comptes au back-office (identity.AccountAdminService) : délai, coupe-circuit et
 * jeton de service par GrpcCaller. Seules les lectures sont rejouées. Aucun journal du numéro ni de
 * la recherche.
 */
export class AccountAdminGrpcAdapter implements AccountAdminApi {
  private readonly logger = new Logger('IdentityAccountAdminGrpc');

  constructor(
    private readonly client: identityV1.AccountAdminServiceClient,
    private readonly caller: GrpcCaller,
  ) {}

  async findByPhone(phone: string): Promise<Json> {
    const res = await this.read('findAccountByPhone', (m) =>
      this.client.findAccountByPhone({ phoneE164: phone }, m),
    );
    return presentAccountMatch(res.account);
  }

  async search(input: { query?: string; limit?: number; cursor?: string }): Promise<Json> {
    const res = await this.read('searchAccounts', (m) =>
      this.client.searchAccounts(
        { query: input.query ?? '', limit: input.limit ?? 0, cursor: input.cursor ?? '' },
        m,
      ),
    );
    return { data: res.accounts.map(presentAdminAccount), nextCursor: res.nextCursor || null };
  }

  async get(userId: string): Promise<Json> {
    const res = await this.read('getAccount', (m) => this.client.getAccount({ userId }, m));
    return presentAccountDetail(res.detail);
  }

  async listAssignableRoles(): Promise<Json> {
    const res = await this.read('listAssignableRoles', (m) => this.client.listAssignableRoles({}, m));
    return {
      data: res.roles.map((role) => ({
        code: role.code,
        service: role.service,
        scopeType: scopeType(role.scopeType),
        description: role.description,
        backofficeAccess: role.backofficeAccess,
        grantable: role.grantable,
      })),
    };
  }

  async grantRole(userId: string, roleCode: string, reason: string): Promise<Json> {
    const res = await this.write('grantAccountRole', (m) =>
      this.client.grantAccountRole({ userId, roleCode, reason }, m),
    );
    return presentAccountDetail(res.detail);
  }

  async revokeRole(userId: string, assignmentId: string, reason: string): Promise<Json> {
    const res = await this.write('revokeAccountRole', (m) =>
      this.client.revokeAccountRole({ userId, assignmentId, reason }, m),
    );
    return presentAccountDetail(res.detail);
  }

  async changeStatus(userId: string, action: AccountStatusAction, reason: string): Promise<Json> {
    const res = await this.write(`${action}Account`, (m) =>
      action === 'suspend'
        ? this.client.suspendAccount({ userId, reason }, m)
        : this.client.reactivateAccount({ userId, reason }, m),
    );
    return presentAccountDetail(res.detail);
  }

  async resetMfa(userId: string, reason: string): Promise<Json> {
    const res = await this.write('resetAccountMfa', (m) =>
      this.client.resetAccountMfa({ userId, reason }, m),
    );
    return presentAccountDetail(res.detail);
  }

  private read<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, { idempotent: true });
  }

  private write<T>(name: string, invoke: (metadata: Metadata) => Observable<T>): Promise<T> {
    return this.call(name, invoke, {});
  }

  private async call<T>(
    name: string,
    invoke: (metadata: Metadata) => Observable<T>,
    options: { idempotent?: boolean },
  ): Promise<T> {
    try {
      return await this.caller.call(name, invoke, options);
    } catch (error) {
      const upstream = toUpstreamError('identity', error);
      if (upstream.code !== (error as AppError)?.code) {
        this.logger.warn(`identity.${name} : ${(error as AppError)?.code ?? 'erreur'} → ${upstream.code}`);
      }
      throw upstream;
    }
  }
}
