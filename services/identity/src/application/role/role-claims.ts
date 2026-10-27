import { type AccessTokenRoleClaim } from '@ksp/contracts';
import { type OrgRole } from '../../domain/organization/organization';
import { type AssignedRole } from '../../domain/role/role';

/** Rôle de tout compte, attribué par défaut (cahier des charges Identité, partie 5). */
export const CUSTOMER_ROLE: AccessTokenRoleClaim = { role: 'customer', scopeType: 'personal' };

/**
 * Rôles d'une session dans le contexte d'une organisation (ADR-027) : le rôle client, plus le rôle
 * du membre dans l'organisation active, de portée org.
 */
export function organizationRoleClaims(organizationId: string, role: OrgRole): AccessTokenRoleClaim[] {
  return [CUSTOMER_ROLE, { role, scopeType: 'org', scopeId: organizationId }];
}

/**
 * Rôles écrits dans le jeton d'une session du back-office : le rôle client, plus les rôles
 * attribués et actifs, avec leur portée. Relus à chaque renouvellement (UC-ID-19).
 */
export function backofficeRoleClaims(assigned: readonly AssignedRole[]): AccessTokenRoleClaim[] {
  return [
    CUSTOMER_ROLE,
    ...assigned.map((role) => ({ role: role.code, scopeType: role.scopeType, scopeId: role.scopeId })),
  ];
}
