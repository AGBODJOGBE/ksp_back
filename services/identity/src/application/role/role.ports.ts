import { type AssignedRole, type RoleDefinition, type RoleScopeType } from '../../domain/role/role';

/** Attribution enregistrée (ou déjà présente) par GrantRole. */
export interface RoleGrant {
  assignmentId: string;
  userId: string;
  roleCode: string;
  scopeType: RoleScopeType;
  scopeId: string | null;
  /** false : l'attribution existait déjà, rien n'a été écrit. */
  created: boolean;
}

export interface RoleRepository {
  /** Rôles attribués au compte et encore actifs, avec les règles de leur définition. */
  activeRoles(userId: string): Promise<AssignedRole[]>;
  findDefinition(code: string): Promise<RoleDefinition | null>;
  /**
   * Attribue le rôle, ou renvoie l'attribution active identique. Une attribution créée écrit
   * l'événement identity.role.granted dans l'outbox, dans la même transaction.
   */
  grant(input: {
    assignmentId: string;
    userId: string;
    roleCode: string;
    scopeType: RoleScopeType;
    scopeId: string | null;
    /** Null : attribution d'amorçage (« system » dans l'événement). */
    grantedBy: string | null;
    now: Date;
  }): Promise<RoleGrant>;
}
