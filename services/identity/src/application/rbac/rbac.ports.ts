import { type RoleScopeType } from '../../domain/role/role';

/** Une permission déclarée par un service (R-RB-01). */
export interface DeclaredPermission {
  code: string;
  description: string;
  service: string;
  retired: boolean;
}

/** Un rôle livré par défaut, déclaré par un service avec son catalogue. */
export interface DefaultRole {
  code: string;
  name: string;
  description: string;
  scopeType: RoleScopeType;
  requiresMfa: boolean;
  backofficeAccess: boolean;
  sensitive: boolean;
  permissions: string[];
}

export interface CatalogRegistration {
  service: string;
  version: number;
  permissions: { code: string; description: string }[];
  roles: DefaultRole[];
  now: Date;
  /** Identifiant donné à chaque rôle créé. */
  newRoleId: () => string;
}

export interface CatalogRegistrationResult {
  permissionsAdded: number;
  permissionsRetired: number;
  rolesCreated: number;
}

/** Catalogue des permissions et des rôles livrés par défaut, en base identity. */
export interface PermissionCatalog {
  /**
   * Enregistre le catalogue d'un service en une transaction : les permissions reçues remplacent les
   * siennes (absentes : retirées ; revenues : rétablies), les rôles absents sont créés, jamais écrasés.
   * Une version inférieure ou égale à la dernière enregistrée est sans effet (bilan à 0).
   */
  register(registration: CatalogRegistration): Promise<CatalogRegistrationResult>;
  permissions(filter: { service: string | null; includeRetired: boolean }): Promise<DeclaredPermission[]>;
  /** Rôles actifs et désactivés, avec leurs permissions cochées ; filtrés sur le service déclarant. */
  roles(service: string | null): Promise<(DefaultRole & { service: string })[]>;
}

/** Un rôle géré au back-office (message ManagedRole du contrat). */
export interface ManagedRoleView {
  code: string;
  name: string;
  description: string;
  service: string;
  origin: 'default' | 'custom';
  scopeType: RoleScopeType;
  permissions: string[];
  sensitive: boolean;
  backofficeAccess: boolean;
  requiresMfa: boolean;
  active: boolean;
  activeAssignments: number;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
}

/** Trace commune des écritures d'un rôle (R-RB-06). */
export interface RoleWrite {
  actorId: string;
  reason: string;
  auditId: string;
  now: Date;
}

/** Code de rôle déjà pris (rôle actif ou désactivé), éventuellement par un appel simultané. */
export class RoleCodeTakenError extends Error {
  override readonly name = 'RoleCodeTakenError';
}

/** Rôle encore attribué : il ne se désactive pas. */
export class RoleInUseError extends Error {
  override readonly name = 'RoleInUseError';
  constructor(readonly activeAssignments: number) {
    super('rôle encore attribué');
  }
}

/** Rôles gérés au back-office. Chaque écriture publie son événement et sa trace d'audit en une transaction. */
export interface ManagedRoleRepository {
  find(code: string): Promise<ManagedRoleView | null>;
  /** Codes inconnus ou retirés parmi ceux donnés. */
  unusablePermissions(codes: readonly string[]): Promise<string[]>;
  /** identity.role.created ; lève RoleCodeTakenError. */
  create(
    input: RoleWrite & {
      id: string;
      code: string;
      name: string;
      description: string;
      permissions: string[];
      sensitive: boolean;
    },
  ): Promise<void>;
  /** identity.role.updated (permissions ajoutées et retirées, avant et après dans l'audit). */
  update(
    input: RoleWrite & {
      code: string;
      name?: string;
      description?: string;
      sensitive?: boolean;
      permissions?: string[];
    },
  ): Promise<void>;
  /** identity.role.deactivated ; lève RoleInUseError s'il reste une attribution active. */
  deactivate(input: RoleWrite & { code: string }): Promise<void>;
}

/** Lectures du personnel pour les autres services (ListStaffByPermission, CheckPermission, GrantRole). */
export interface StaffDirectory {
  /**
   * Comptes actifs dont une attribution active d'un rôle actif porte la permission : sans limite de
   * zone, ou limitée à `zoneKey` (vide : attributions sans zone seulement). super_admin compris.
   */
  staffWith(permission: string, zoneKey: string | null): Promise<string[]>;
  /** État du compte ; null s'il n'existe pas. */
  accountStatus(userId: string): Promise<string | null>;
  /** Attribution (active ou retirée) : son titulaire et son rôle ; null si elle n'existe pas. */
  assignment(assignmentId: string): Promise<{ userId: string; roleCode: string; revoked: boolean } | null>;
}
