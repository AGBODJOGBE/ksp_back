import { AppError } from '@ksp/platform';
import { effectivePermissions, invalidZoneKeys, isPermissionCode } from '../../domain/role/permission';
import { defaultAssignmentScope, type RoleScopeType } from '../../domain/role/role';
import { isUuid } from '../context/active-contexts';
import {
  RoleAssignmentNotFoundError,
  RoleAssignmentRevokedError,
  type RoleGrant,
  RoleInactiveError,
  type RoleRepository,
} from '../role/role.ports';
import { type Clock, type IdGenerator } from '../shared/system.ports';
import { rbacReason } from './catalog.use-cases';
import { rbacErrors } from './rbac-errors';
import { type StaffDirectory } from './rbac.ports';

/**
 * Rôles et permissions vus par les autres services (IdentityService ; ADR-057). L'appelant vient du
 * jeton de service vérifié ; null sans vérificateur (développement seulement, le kit l'interdit en
 * production) : tout est alors permis, comme pour l'annuaire.
 */

/**
 * Attribution par un service (IDENTITY_ROLE_GRANT_CALLERS du contrat) : rôles que chaque service peut
 * attribuer et retirer. cleaning donne cleaning_agent à la validation d'un agent (R-AG-01, décision 8).
 */
export const ROLE_GRANT_CALLERS: Readonly<Record<string, readonly string[]>> = {
  cleaning: ['cleaning_agent'],
};

/** Personnel à prévenir (partie 16.2, RV-62) : notification seul. */
export const STAFF_DIRECTORY_CALLERS: readonly string[] = ['notification'];

const roleForbidden = () =>
  AppError.forbidden('IDENTITY_ROLE_FORBIDDEN', 'Ce service ne peut pas attribuer ce rôle.');
const userNotFound = () => AppError.notFound('IDENTITY_USER_NOT_FOUND', 'Compte introuvable.');

/** Rôles que l'appelant peut attribuer ; null : appelant non autorisé. */
function grantableBy(callerService: string | null): readonly string[] | null {
  if (callerService === null) return Object.values(ROLE_GRANT_CALLERS).flat();
  return Object.hasOwn(ROLE_GRANT_CALLERS, callerService) ? (ROLE_GRANT_CALLERS[callerService] ?? []) : null;
}

/**
 * GrantRole : idempotent (une attribution active identique est rendue telle quelle), tracé dans le
 * journal d'audit avec le service pour auteur, événement identity.role.granted (version 2).
 */
export class GrantRoleUseCase {
  constructor(
    private readonly roles: RoleRepository,
    private readonly staff: StaffDirectory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    callerService: string | null,
    input: { userId: string; roleCode: string; zoneKeys?: string[]; reason: string },
  ): Promise<RoleGrant> {
    const allowed = grantableBy(callerService);
    if (!allowed) throw rbacErrors.callerForbidden();
    if (!allowed.includes(input.roleCode)) throw roleForbidden();
    const reason = rbacReason(input.reason);
    if (input.zoneKeys && invalidZoneKeys(input.zoneKeys)) throw rbacErrors.roleInvalid('zoneKeys');
    const status = isUuid(input.userId) ? await this.staff.accountStatus(input.userId) : null;
    if (!status || status === 'deleted') throw userNotFound();
    const role = await this.roles.findDefinition(input.roleCode);
    if (!role) throw rbacErrors.roleNotFound();
    if (role.active === false) throw rbacErrors.inactive();
    if (status !== 'active') {
      throw AppError.precondition('IDENTITY_ACCOUNT_NOT_ACTIVE', 'Ce compte n’est pas actif.', { status });
    }
    const roleScope = defaultAssignmentScope(role);
    if (!roleScope) throw roleForbidden();
    const zoneKeys = input.zoneKeys ? [...input.zoneKeys].sort() : [];
    const scope: { scopeType: RoleScopeType; scopeId: string | null } = zoneKeys.length
      ? { scopeType: 'zone', scopeId: null }
      : roleScope;
    try {
      return await this.roles.grant({
        assignmentId: this.ids.next(),
        userId: input.userId,
        roleCode: role.code,
        ...scope,
        zoneKeys,
        grantedBy: null,
        now: this.clock.now(),
        audit: { id: this.ids.next(), reason, service: callerService ?? 'system' },
      });
    } catch (error) {
      if (error instanceof RoleInactiveError) throw rbacErrors.inactive();
      throw error;
    }
  }
}

/** RevokeRole : retrait par le service qui a attribué le rôle (mêmes rôles que GrantRole). */
export class RevokeRoleUseCase {
  constructor(
    private readonly roles: RoleRepository,
    private readonly staff: StaffDirectory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(
    callerService: string | null,
    input: { assignmentId: string; reason: string },
  ): Promise<void> {
    const allowed = grantableBy(callerService);
    if (!allowed) throw rbacErrors.callerForbidden();
    const reason = rbacReason(input.reason);
    const notFound = () =>
      AppError.notFound('IDENTITY_ROLE_ASSIGNMENT_NOT_FOUND', 'Cette attribution est introuvable.');
    const assignment = isUuid(input.assignmentId) ? await this.staff.assignment(input.assignmentId) : null;
    if (!assignment) throw notFound();
    if (!allowed.includes(assignment.roleCode)) throw roleForbidden();
    // Déjà retirée : rien à faire (rejouable).
    if (assignment.revoked) return;
    try {
      await this.roles.revoke({
        assignmentId: input.assignmentId,
        userId: assignment.userId,
        actorId: null,
        service: callerService ?? 'system',
        reason,
        auditId: this.ids.next(),
        now: this.clock.now(),
      });
    } catch (error) {
      if (error instanceof RoleAssignmentRevokedError) return;
      if (error instanceof RoleAssignmentNotFoundError) throw notFound();
      throw error;
    }
  }
}

/** ListStaffByPermission (RV-62) : notification joint le personnel d'une zone. */
export class ListStaffByPermissionUseCase {
  constructor(private readonly staff: StaffDirectory) {}

  async execute(
    callerService: string | null,
    input: { permission: string; zoneKey: string },
  ): Promise<string[]> {
    if (callerService !== null && !STAFF_DIRECTORY_CALLERS.includes(callerService)) {
      throw rbacErrors.callerForbidden();
    }
    if (!isPermissionCode(input.permission)) return [];
    return this.staff.staffWith(input.permission, input.zoneKey || null);
  }
}

/**
 * CheckPermission : contrôle à jour, sans attendre le renouvellement du jeton (actions sensibles).
 * Portée zone : la clé de commune est dans scope_id ; une permission valable partout suffit.
 */
export class CheckPermissionUseCase {
  constructor(
    private readonly roles: RoleRepository,
    private readonly staff: StaffDirectory,
  ) {}

  async execute(input: {
    userId: string;
    permission: string;
    scopeType: RoleScopeType | null;
    scopeId: string;
  }): Promise<{ allowed: boolean; reason: string }> {
    const status = isUuid(input.userId) ? await this.staff.accountStatus(input.userId) : null;
    if (!status || status === 'deleted') return { allowed: false, reason: 'account_not_found' };
    if (status !== 'active') return { allowed: false, reason: 'account_not_active' };
    const { perms, zonePerms } = effectivePermissions(await this.roles.activeRoles(input.userId), {
      allPermissions: [],
    });
    if (perms.includes(input.permission)) return { allowed: true, reason: '' };
    if (input.scopeType === 'zone' && zonePerms[input.scopeId]?.includes(input.permission)) {
      return { allowed: true, reason: '' };
    }
    return { allowed: false, reason: 'permission_missing' };
  }
}
