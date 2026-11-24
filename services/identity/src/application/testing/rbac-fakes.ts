import {
  type CatalogRegistration,
  type CatalogRegistrationResult,
  type DeclaredPermission,
  type DefaultRole,
  type ManagedRoleRepository,
  type ManagedRoleView,
  type PermissionCatalog,
  RoleCodeTakenError,
  RoleInUseError,
} from '../rbac/rbac.ports';

/** Catalogue et rôles gérés en mémoire, pour les tests des cas d'usage. */
export class InMemoryRbac implements PermissionCatalog, ManagedRoleRepository {
  readonly permissionRows = new Map<string, DeclaredPermission>();
  readonly roleRows = new Map<string, ManagedRoleView>();
  readonly versions = new Map<string, number>();
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  /** Attributions actives par code de rôle. */
  readonly activeAssignments = new Map<string, number>();
  /** Traces d'audit des rôles par défaut complétés par un catalogue. */
  readonly audit: { actorId: string; action: string; entityId: string; details: Record<string, unknown> }[] =
    [];

  declare(code: string, retired = false): void {
    this.permissionRows.set(code, { code, description: code, service: code.split('.')[0] ?? '', retired });
  }

  addRole(role: Partial<ManagedRoleView> & { code: string }): void {
    this.roleRows.set(role.code, {
      name: role.code,
      description: '',
      service: 'identity',
      origin: 'default',
      scopeType: 'global',
      permissions: [],
      sensitive: false,
      backofficeAccess: true,
      requiresMfa: true,
      active: true,
      activeAssignments: 0,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      createdBy: null,
      updatedAt: null,
      updatedBy: null,
      deactivatedAt: null,
      deactivatedBy: null,
      ...role,
    });
  }

  async register(input: CatalogRegistration): Promise<CatalogRegistrationResult> {
    if ((this.versions.get(input.service) ?? 0) >= input.version) {
      return { permissionsAdded: 0, permissionsRetired: 0, rolesCreated: 0 };
    }
    this.versions.set(input.service, input.version);
    const declared = new Set(input.permissions.map((permission) => permission.code));
    let added = 0;
    let retired = 0;
    for (const permission of input.permissions) {
      const row = this.permissionRows.get(permission.code);
      if (!row || row.retired) added += 1;
      this.permissionRows.set(permission.code, { ...permission, service: input.service, retired: false });
    }
    for (const row of this.permissionRows.values()) {
      if (row.service === input.service && !row.retired && !declared.has(row.code)) {
        row.retired = true;
        retired += 1;
      }
    }
    let created = 0;
    for (const role of input.roles) {
      const existing = this.roleRows.get(role.code);
      if (existing) {
        // Comme le dépôt réel : rôle par défaut jamais modifié → permissions du service ajoutées.
        const untouched =
          existing.origin === 'default' && !existing.updatedAt && !existing.updatedBy && existing.active;
        const missing = [...new Set(role.permissions)]
          .filter((code) => declared.has(code) && !existing.permissions.includes(code))
          .sort();
        if (untouched && missing.length) {
          const before = [...existing.permissions].sort();
          existing.permissions = [...before, ...missing].sort();
          this.audit.push({
            actorId: input.service,
            action: 'role.default_permissions_added',
            entityId: role.code,
            details: { permissionsAdded: missing, before, after: existing.permissions },
          });
        }
        continue;
      }
      this.addRole({ ...role, service: input.service, createdAt: input.now });
      created += 1;
    }
    return { permissionsAdded: added, permissionsRetired: retired, rolesCreated: created };
  }

  async permissions(filter: {
    service: string | null;
    includeRetired: boolean;
  }): Promise<DeclaredPermission[]> {
    return [...this.permissionRows.values()].filter(
      (row) => (!filter.service || row.service === filter.service) && (filter.includeRetired || !row.retired),
    );
  }

  async roles(service: string | null): Promise<(DefaultRole & { service: string })[]> {
    return [...this.roleRows.values()].filter((role) => !service || role.service === service);
  }

  async find(code: string): Promise<ManagedRoleView | null> {
    const role = this.roleRows.get(code);
    return role ? { ...role, activeAssignments: this.activeAssignments.get(code) ?? 0 } : null;
  }

  async unusablePermissions(codes: readonly string[]): Promise<string[]> {
    return codes.filter((code) => !this.permissionRows.get(code) || this.permissionRows.get(code)?.retired);
  }

  async create(input: Parameters<ManagedRoleRepository['create']>[0]): Promise<void> {
    if (this.roleRows.has(input.code)) throw new RoleCodeTakenError();
    this.addRole({ ...input, origin: 'custom', createdAt: input.now, createdBy: input.actorId });
    this.events.push({ type: 'identity.role.created', payload: { roleCode: input.code } });
  }

  async update(input: Parameters<ManagedRoleRepository['update']>[0]): Promise<void> {
    const role = this.roleRows.get(input.code)!;
    const before = role.permissions;
    Object.assign(role, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
      updatedAt: input.now,
      updatedBy: input.actorId,
    });
    this.events.push({
      type: 'identity.role.updated',
      payload: {
        roleCode: input.code,
        permissionsAdded: role.permissions.filter((code) => !before.includes(code)),
        permissionsRemoved: before.filter((code) => !role.permissions.includes(code)),
      },
    });
  }

  async deactivate(input: Parameters<ManagedRoleRepository['deactivate']>[0]): Promise<void> {
    const count = this.activeAssignments.get(input.code) ?? 0;
    if (count > 0) throw new RoleInUseError(count);
    Object.assign(this.roleRows.get(input.code)!, {
      active: false,
      deactivatedAt: input.now,
      deactivatedBy: input.actorId,
    });
    this.events.push({ type: 'identity.role.deactivated', payload: { roleCode: input.code } });
  }
}
