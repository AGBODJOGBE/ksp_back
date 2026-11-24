import { hasRole, requireUser } from '@ksp/platform';
import { type OrganizationRole } from '../../domain/requests/organization-access';
import { requireConnectedUser } from '../shared/access';
import { executionErrors } from './execution-errors';
import { type OwnerKind } from './execution.ports';

/**
 * Périmètre du client (R-CP-03) : son organisation active, sinon ses dossiers personnels. Un
 * dossier hors périmètre répond « introuvable » (partie 16.3).
 */
export interface CustomerScope {
  userId: string;
  ownerKind: OwnerKind;
  ownerId: string;
  /** Rôle dans l'organisation active ; null en contexte personnel. */
  role: OrganizationRole | null;
}

const ROLES: readonly OrganizationRole[] = ['org_admin', 'org_member', 'org_viewer'];

export function currentCustomer(): CustomerScope {
  const userId = requireConnectedUser();
  const user = requireUser();
  const organizationId = user.activeContext && user.activeContext !== 'personal' ? user.activeContext : null;
  if (!organizationId) return { userId, ownerKind: 'user', ownerId: userId, role: null };
  const role =
    ROLES.find((candidate) => hasRole(user, candidate, { type: 'org', id: organizationId })) ?? null;
  // Sans rôle dans l'organisation active : rien n'est visible (lecteur au mieux).
  return { userId, ownerKind: 'organization', ownerId: organizationId, role: role ?? 'org_viewer' };
}

/** Le programme appartient au périmètre du client. */
export function inScope(scope: CustomerScope, owner: { ownerKind: OwnerKind; ownerId: string }): boolean {
  return owner.ownerKind === scope.ownerKind && owner.ownerId === scope.ownerId;
}

const RANK: Readonly<Record<OrganizationRole, number>> = { org_viewer: 0, org_member: 1, org_admin: 2 };

/** Rôle minimal dans l'organisation (R-CP-03) ; contexte personnel : le titulaire a tous les droits. */
export function requireOrganizationRole(scope: CustomerScope, minimum: 'org_member' | 'org_admin'): void {
  if (scope.role !== null && RANK[scope.role] < RANK[minimum]) throw executionErrors.orgRoleRequired();
}
