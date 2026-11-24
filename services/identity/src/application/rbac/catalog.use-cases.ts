import { normalizeReason } from '../../domain/organization/organization';
import { isPermissionCode, permissionService } from '../../domain/role/permission';
import { catalogProblems, type RoleScopeType } from '../../domain/role/role';
import { SUPER_ADMIN_ROLE } from '../../domain/role/role-administration';
import { requireStaff } from '../organization/organization-admin.use-cases';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { rbacErrors } from './rbac-errors';
import {
  type CatalogRegistrationResult,
  type DeclaredPermission,
  type DefaultRole,
  type PermissionCatalog,
} from './rbac.ports';

/** Portées qu'un rôle livré par défaut peut déclarer : celles du back-office. */
const DEFAULT_ROLE_SCOPES: readonly RoleScopeType[] = ['global', 'domain'];

export interface CatalogInput {
  service: string;
  version: number;
  permissions: { code: string; description: string }[];
  roles: DefaultRole[];
}

/**
 * R-RB-01 : un service déclare son catalogue de permissions (et ses rôles livrés par défaut) à chaque
 * déploiement. Le service déclaré est toujours celui du jeton de service ; sans vérificateur
 * (développement seulement), celui de la requête. Un rôle livré par défaut que personne n'a modifié
 * au back-office reçoit les permissions du service déclarées pour lui (R-RB-02 : un rôle modifié par
 * un administrateur n'est jamais écrasé).
 */
export class RegisterCatalogUseCase {
  constructor(
    private readonly catalog: PermissionCatalog,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(callerService: string | null, input: CatalogInput): Promise<CatalogRegistrationResult> {
    const service = callerService ?? input.service;
    if (!/^[a-z][a-z0-9_]*$/.test(service)) throw rbacErrors.catalogInvalid('service');
    if (!Number.isInteger(input.version) || input.version < 1)
      throw rbacErrors.catalogInvalid('catalogVersion');
    const declared = new Set<string>();
    for (const permission of input.permissions) {
      if (!isPermissionCode(permission.code) || permissionService(permission.code) !== service) {
        throw rbacErrors.catalogInvalid(`permissions.${permission.code}`);
      }
      if (declared.has(permission.code)) throw rbacErrors.catalogInvalid(`permissions.${permission.code}`);
      declared.add(permission.code);
    }
    for (const role of input.roles) {
      if (!DEFAULT_ROLE_SCOPES.includes(role.scopeType))
        throw rbacErrors.catalogInvalid(`roles.${role.code}`);
      // Un rôle livré par un service ne coche que des permissions déjà déclarées (les siennes ou
      // celles d'un autre service) ; celles d'un autre service sont contrôlées par le dépôt.
      const unknown = role.permissions.find((code) => !isPermissionCode(code));
      if (unknown) throw rbacErrors.catalogInvalid(`roles.${role.code}.permissions`);
    }
    const problem = catalogProblems(input.roles.map((role) => ({ ...role, service })))[0];
    if (problem) throw rbacErrors.catalogInvalid(`roles.${problem.split(' ')[0]}`);
    return this.catalog.register({
      service,
      version: input.version,
      permissions: input.permissions,
      roles: input.roles,
      now: this.clock.now(),
      newRoleId: () => this.ids.next(),
      newAuditId: () => this.ids.next(),
    });
  }
}

/** Catalogue lu par un service (GetCatalog) : permissions non retirées et rôles livrés. */
export class GetCatalogUseCase {
  constructor(private readonly catalog: PermissionCatalog) {}

  async execute(service: string): Promise<{
    permissions: DeclaredPermission[];
    roles: (DefaultRole & { service: string })[];
  }> {
    const filter = service || null;
    const [permissions, roles] = await Promise.all([
      this.catalog.permissions({ service: filter, includeRetired: false }),
      this.catalog.roles(filter),
    ]);
    return { permissions, roles };
  }
}

/** super_admin : cases à cocher d'un rôle, triées par service, module puis code (R-RB-01). */
export class ListPermissionsUseCase {
  constructor(private readonly catalog: PermissionCatalog) {}

  async execute(input: { service: string; includeRetired: boolean }): Promise<DeclaredPermission[]> {
    requireStaff([SUPER_ADMIN_ROLE]);
    const permissions = await this.catalog.permissions({
      service: input.service || null,
      includeRetired: input.includeRetired,
    });
    // Le code commence par le service puis le module : l'ordre du code suffit.
    return [...permissions].sort((a, b) => a.code.localeCompare(b.code));
  }
}

/** Motif obligatoire d'une écriture (500 caractères au plus, sur une ligne). */
export function rbacReason(value: string | undefined): string {
  const reason = normalizeReason(value ?? '');
  if (!reason) throw rbacErrors.reasonRequired();
  return reason;
}
