import { type AccessTokenRoleClaim } from '@ksp/contracts';
import { type AssignedRole } from '../../domain/role/role';

/** Rôle de tout compte, attribué par défaut (cahier des charges Identité, partie 5). */
export const CUSTOMER_ROLE: AccessTokenRoleClaim = { role: 'customer', scopeType: 'personal' };

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
