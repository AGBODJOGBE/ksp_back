import { type AssignedRole, type RoleDefinition, type RoleScopeType } from '../../domain/role/role';

/** Attribution enregistrée (ou déjà présente) par GrantRole. */
export interface RoleGrant {
  assignmentId: string;
  userId: string;
  roleCode: string;
  scopeType: RoleScopeType;
  scopeId: string | null;
  /** Portée zone : clés de commune, triées ; vide sinon. */
  zoneKeys: string[];
  /** Date de l'attribution (celle déjà active quand rien n'a été écrit). */
  grantedAt: Date;
  /** false : l'attribution existait déjà, rien n'a été écrit. */
  created: boolean;
}

/** Retrait d'une attribution depuis l'administration des comptes (ADR-043). */
export interface RoleRevocation {
  assignmentId: string;
  userId: string;
  /** Compte auteur du retrait ; null pour un retrait fait par un service (`service`). */
  actorId: string | null;
  /** Service auteur (RevokeRole), tracé et publié à la place d'un compte. */
  service?: string;
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

/** Le rôle est désactivé (éventuellement par un appel simultané) : il ne s'attribue plus. */
export class RoleInactiveError extends Error {
  override readonly name = 'RoleInactiveError';
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
   * Attribue le rôle, ou renvoie l'attribution active identique (même portée, mêmes zones). Une
   * attribution créée écrit l'événement identity.role.granted (version 2) dans l'outbox et, depuis
   * le back-office ou un service, la trace d'audit, dans la même transaction. Lève
   * RoleInactiveError pour un rôle désactivé.
   */
  grant(input: {
    assignmentId: string;
    userId: string;
    roleCode: string;
    scopeType: RoleScopeType;
    scopeId: string | null;
    /** Portée zone : 1 à 77 clés de commune, triées ; vide sinon. */
    zoneKeys: string[];
    /** Null : attribution d'amorçage (« system » dans l'événement). */
    grantedBy: string | null;
    now: Date;
    /** Attribution depuis le back-office : motif conservé et trace d'audit (ADR-043). */
    audit?: {
      id: string;
      reason: string;
      /** Auteur tracé quand ce n'est pas un compte : le service appelant (GrantRole). */
      service?: string;
    };
  }): Promise<RoleGrant>;
  /**
   * Retire l'attribution, avec l'événement identity.role.revoked et la trace d'audit, en une
   * transaction. Rôle sensible (ou super_admin, R-RB-05) : toutes les sessions de la personne sont
   * fermées dans la même transaction (sessionsRevoked). Lève RoleAssignmentNotFoundError,
   * RoleAssignmentRevokedError, et LastSuperAdminError pour le dernier rôle super_admin d'un compte actif.
   */
  revoke(revocation: RoleRevocation): Promise<{ roleCode: string; sessionsRevoked: boolean }>;
}
