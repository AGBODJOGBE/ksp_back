import { requireRecentMfa } from '@ksp/platform';
import { roleInputProblem } from '../../domain/role/permission';
import { SUPER_ADMIN_ROLE } from '../../domain/role/role-administration';
import { CRITICAL_MFA_MAX_AGE_SECONDS } from '../account-admin/account-admin.use-cases';
import { requireStaff } from '../organization/organization-admin.use-cases';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { rbacReason } from './catalog.use-cases';
import { rbacErrors } from './rbac-errors';
import {
  type ManagedRoleRepository,
  type ManagedRoleView,
  RoleCodeTakenError,
  RoleInUseError,
} from './rbac.ports';

/**
 * Rôles dynamiques du super administrateur (R-RB-02, R-RB-04, R-RB-06 ; ADR-057). La gateway filtre
 * déjà par rôle ; identity revérifie le rôle et la double authentification. Chaque écriture exige
 * une double authentification de moins de 10 minutes et un motif.
 */

/** Fiche d'un rôle, avec ce que le contrat calcule : super_admin n'est jamais modifiable. */
export interface ManagedRoleOutput extends ManagedRoleView {
  editable: boolean;
}

const output = (role: ManagedRoleView): ManagedRoleOutput => ({
  ...role,
  editable: role.code !== SUPER_ADMIN_ROLE,
});

function requireRoleWriter(): string {
  const actorId = requireStaff([SUPER_ADMIN_ROLE]);
  requireRecentMfa(CRITICAL_MFA_MAX_AGE_SECONDS);
  return actorId;
}

/** Lecture commune : rôle connu, sinon IDENTITY_ROLE_NOT_FOUND. */
async function existing(roles: ManagedRoleRepository, code: string): Promise<ManagedRoleView> {
  const role = await roles.find(code);
  if (!role) throw rbacErrors.roleNotFound();
  return role;
}

/** Contrôle des permissions cochées : déclarées et non retirées. */
async function requireUsable(roles: ManagedRoleRepository, codes: readonly string[]): Promise<void> {
  const unusable = codes.length ? await roles.unusablePermissions(codes) : [];
  if (unusable.length) throw rbacErrors.permissionNotFound(unusable);
}

export class GetRoleUseCase {
  constructor(private readonly roles: ManagedRoleRepository) {}

  async execute(code: string): Promise<ManagedRoleOutput> {
    requireStaff([SUPER_ADMIN_ROLE]);
    return output(await existing(this.roles, code));
  }
}

/** Nouveau rôle, actif, portée globale, back-office et double authentification (identity.role.created). */
export class CreateRoleUseCase {
  constructor(
    private readonly roles: ManagedRoleRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    code: string;
    name: string;
    description: string;
    permissions: string[];
    sensitive: boolean;
    reason?: string;
  }): Promise<ManagedRoleOutput> {
    const actorId = requireRoleWriter();
    const problem = roleInputProblem(input);
    if (problem) throw rbacErrors.roleInvalid(problem);
    const reason = rbacReason(input.reason);
    await requireUsable(this.roles, input.permissions);
    try {
      await this.roles.create({
        id: this.ids.next(),
        code: input.code,
        name: input.name.trim(),
        description: input.description.trim(),
        permissions: [...input.permissions].sort(),
        sensitive: input.sensitive,
        actorId,
        reason,
        auditId: this.ids.next(),
        now: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof RoleCodeTakenError) throw rbacErrors.roleExists();
      throw error;
    }
    return output(await existing(this.roles, input.code));
  }
}

/**
 * Modifie nom, description, sensibilité ou permissions (liste complète qui remplace la précédente),
 * rôle livré par défaut compris, sauf super_admin (identity.role.updated). Effet au renouvellement.
 */
export class UpdateRoleUseCase {
  constructor(
    private readonly roles: ManagedRoleRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    code: string;
    name?: string;
    description?: string;
    sensitive?: boolean;
    permissions?: string[];
    reason?: string;
  }): Promise<ManagedRoleOutput> {
    const actorId = requireRoleWriter();
    const current = await existing(this.roles, input.code);
    if (current.code === SUPER_ADMIN_ROLE) throw rbacErrors.notEditable();
    if (!current.active) throw rbacErrors.inactive();
    const problem = roleInputProblem({
      code: current.code,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      permissions: input.permissions ?? [],
    });
    if (problem) throw rbacErrors.roleInvalid(problem);
    const reason = rbacReason(input.reason);
    if (input.permissions) await requireUsable(this.roles, input.permissions);
    await this.roles.update({
      code: current.code,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.sensitive !== undefined ? { sensitive: input.sensitive } : {}),
      ...(input.permissions ? { permissions: [...input.permissions].sort() } : {}),
      actorId,
      reason,
      auditId: this.ids.next(),
      now: this.clock.now(),
    });
    return output(await existing(this.roles, current.code));
  }
}

/** Rôle actif sans attribution active → désactivé (identity.role.deactivated). */
export class DeactivateRoleUseCase {
  constructor(
    private readonly roles: ManagedRoleRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: { code: string; reason?: string }): Promise<ManagedRoleOutput> {
    const actorId = requireRoleWriter();
    const current = await existing(this.roles, input.code);
    if (current.code === SUPER_ADMIN_ROLE) throw rbacErrors.notEditable();
    if (!current.active) throw rbacErrors.inactive();
    const reason = rbacReason(input.reason);
    try {
      await this.roles.deactivate({
        code: current.code,
        actorId,
        reason,
        auditId: this.ids.next(),
        now: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof RoleInUseError) throw rbacErrors.inUse(error.activeAssignments);
      throw error;
    }
    return output(await existing(this.roles, current.code));
  }
}
