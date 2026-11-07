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

/** Retrait d'une attribution depuis l'administration des comptes (ADR-038). */
export interface RoleRevocation {
  assignmentId: string;
  userId: string;
  actorId: string;
  reason: string;
  auditId: string;
  now: Date;
}

/** L'attribution n'existe pas pour ce compte. */
export class RoleAssignmentNotFoundError extends Error {
  override readonly name = 'RoleAssignmentNotFoundError';
}

/** L'attribution est déjà retirée (éventuellement par un appel simultané). */
export class RoleAssignmentRevokedError extends Error {
  override readonly name = 'RoleAssignmentRevokedError';
}

/** L'écriture laisserait le système sans super administrateur actif. */
export class LastSuperAdminError extends Error {
  override readonly name = 'LastSuperAdminError';
}

export interface RoleRepository {
  /** Rôles attribués au compte et encore actifs, avec les règles de leur définition. */
  activeRoles(userId: string): Promise<AssignedRole[]>;
  findDefinition(code: string): Promise<RoleDefinition | null>;
  /**
   * Attribue le rôle, ou renvoie l'attribution active identique. Une attribution créée écrit
   * l'événement identity.role.granted dans l'outbox et, depuis le back-office, la trace d'audit,
   * dans la même transaction.
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
    /** Attribution depuis le back-office : motif conservé et trace d'audit (ADR-038). */
    audit?: { id: string; reason: string };
  }): Promise<RoleGrant>;
  /**
   * Retire l'attribution, avec l'événement identity.role.revoked et la trace d'audit, en une
   * transaction. Lève RoleAssignmentNotFoundError, RoleAssignmentRevokedError, et
   * LastSuperAdminError pour le dernier rôle super_admin d'un compte actif.
   */
  revoke(revocation: RoleRevocation): Promise<{ roleCode: string }>;
}
